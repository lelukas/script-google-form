import { Builder, By, until } from 'selenium-webdriver'
import chrome from 'selenium-webdriver/chrome'
import path from 'path'
import { appendFileSync, mkdirSync, writeFileSync } from 'fs'
import dados from '../dados.json'
import { checkData, checkEnv, checkEnvMonth } from './utils'
import { config } from 'dotenv'
;(async () => {
  config()
  checkEnv(process.env)
  await checkData(dados)
  await checkEnvMonth(process.env)

  const inputSelector = 'input.whsOnd.zHQkBf'
  const selectOptionsSelector = 'div.OA0qNb.ncFHed.QXL7Te'
  const fileButtonSelector = 'div.uArJ5e.cd29Sd'
  const iFrameXPath = By.xpath(`//iframe[contains(@allow, "camera 'src' https://docs.google.com")]`)
  const options = new chrome.Options()
  options.debuggerAddress(`localhost:${process.env.DEBUG_PORT ?? 9222}`)
  options.addArguments(
    '--disable-blink-features=AutomationControlled',
    '--disable-infobars',
    '--disable-web-security',
    '--allow-running-insecure-content',
    '--disable-site-isolation-trials',
    '--no-sandbox',
    '--disable-dev-shm-usage',
  )

  const builder = new Builder().forBrowser('chrome').setChromeOptions(options)
  if (process.env.CHROMEDRIVER_PATH) {
    builder.setChromeService(new chrome.ServiceBuilder(process.env.CHROMEDRIVER_PATH))
  }
  const driver = await builder.build()
  await driver.executeScript(`window.open('${process.env.URL}', '_blank')`)
  const handles = await driver.getAllWindowHandles()
  await driver.switchTo().window(handles[handles.length - 1])
  await driver.wait(until.elementLocated(By.css('input')), 10000)

  const selectInSelectBlock = async (label: string, value: string) => {
    const select = await driver.findElement(By.xpath(`//span[b/i[text()='${label}']]/../../../..//*[@role="listbox"]`))
    await select.click()
    const selectOptions = select.findElement(By.css(selectOptionsSelector))
    await driver.executeScript('console.log(arguments[0])', selectOptions)
    await driver.wait(until.elementIsVisible(selectOptions))
    const option = await selectOptions.findElement(By.xpath(`./div[@data-value="${value}"]`))
    await driver.executeScript('console.log(arguments[0])', option)
    await option.click()
    await driver.wait(until.elementIsNotVisible(selectOptions), 5000)
  }

  const selectInCheckboxBlock = async (label: string, value: string) => {
    const container = await driver.findElement(By.xpath(`//span[b/i[text()='${label}']]/../../../..`))
    const item = container.findElement(By.xpath(`//span[text()='${value}']`))
    await item.click()
  }

  type CdpNode = {
    nodeName: string
    attributes?: string[]
    backendNodeId: number
    children?: CdpNode[]
    contentDocument?: CdpNode
  }
  const findFileInputs = (node: CdpNode, out: CdpNode[] = []) => {
    if (node.nodeName === 'INPUT' && node.attributes?.includes('file')) out.push(node)
    node.children?.forEach((child) => findFileInputs(child, out))
    if (node.contentDocument) findFileInputs(node.contentDocument, out)
    return out
  }
  // chromedriver não expõe o retorno dos comandos CDP; abre um websocket direto no tab atual
  const setFileViaCdp = async (filePath: string) => {
    const port = process.env.DEBUG_PORT ?? 9222
    const currentUrl = await driver.getCurrentUrl()
    const targets = (await (await fetch(`http://localhost:${port}/json/list`)).json()) as {
      type: string
      url: string
      webSocketDebuggerUrl: string
    }[]
    const target = targets.find((t) => t.type === 'page' && t.url === currentUrl)
    if (!target) throw new Error('tab do formulário não encontrado no CDP')
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      ws.onopen = resolve
      ws.onerror = reject
      setTimeout(() => reject(new Error('timeout abrindo websocket CDP')), 5000)
    })
    let id = 0
    const pending = new Map<number, (data: { result?: any; error?: { message: string } }) => void>()
    ws.onmessage = (m) => {
      const data = JSON.parse(String(m.data))
      pending.get(data.id)?.(data)
    }
    const send = (method: string, params: object = {}) =>
      new Promise<any>((resolve, reject) => {
        const i = ++id
        pending.set(i, (data) => (data.error ? reject(new Error(data.error.message)) : resolve(data.result)))
        setTimeout(() => reject(new Error(`timeout CDP ${method}`)), 10000)
        ws.send(JSON.stringify({ id: i, method, params }))
      })
    try {
      const { root } = await send('DOM.getDocument', { depth: -1, pierce: true })
      // iframes de pickers antigos ficam no DOM (ocultos); o picker atual é sempre o último
      const input = findFileInputs(root).at(-1)
      if (!input) throw new Error('input[type=file] do picker não encontrado')
      await send('DOM.setFileInputFiles', { files: [filePath], backendNodeId: input.backendNodeId })
    } finally {
      ws.close()
    }
  }

  const parseValor = (valor: string) => {
    if (valor.includes(',')) {
      const split = valor.split(',')
      if (split[1].length === 0) return `${split[0]},00`
      if (split[1].length === 1) return `${split[0]},${split[1]}0}`
      return valor
    }
    return `${valor},00`
  }

  const logFile = path.resolve('./run.log')
  const log = (msg: string) => {
    const line = `[${new Date().toISOString()}] ${msg}`
    console.log(line)
    appendFileSync(logFile, `${line}\n`)
  }

  class RetryError extends Error {}
  const maxAttempts = 3
  const enviarOutraRespostaXPath = By.xpath('//a[text()="Enviar outra resposta"]')

  const draftModalButton = async () => {
    const buttons = await driver.findElements(
      By.xpath(
        `//*[@role="dialog" or @role="alertdialog"][.//*[contains(text(), "Progresso salvo")]]//*[text()="Atualizar"]`,
      ),
    )
    for (const button of buttons) if (await button.isDisplayed()) return button
    return null
  }

  // modal de rascunho mais recente: fecha e sinaliza que o estado do form está sujo
  const dismissDraftModal = async () => {
    const button = await draftModalButton()
    if (!button) return false
    log('modal de rascunho detectado, clicando em Atualizar')
    await button.click()
    await driver.wait(async () => !(await draftModalButton()), 10000)
    await driver.wait(until.elementLocated(By.css(inputSelector)), 15000)
    return true
  }

  const assertNoModal = async () => {
    if (await dismissDraftModal()) throw new RetryError('modal de rascunho apareceu durante o preenchimento')
  }

  let currentStep = ''
  const step = async <T>(name: string, fn: () => Promise<T>) => {
    currentStep = name
    log(`  · ${name}`)
    return fn()
  }

  // grava em ./erros/<data>-<nome>-t<tentativa>/: error.txt (stack + estado), screenshot.png e page.html
  const dumpError = async (e: unknown, nome: string, attempt: number) => {
    try {
      const slug = nome.normalize('NFD').replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 40)
      const dir = path.resolve('./erros', `${new Date().toISOString().replace(/[:.]/g, '-')}-${slug}-t${attempt}`)
      mkdirSync(dir, { recursive: true })
      const safe = async <T>(fn: () => Promise<T>) => {
        try {
          return await fn()
        } catch (err) {
          return `<falhou: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}>`
        }
      }
      const state = await safe(() =>
        driver.executeScript<unknown>(`return {
          url: location.href,
          readyState: document.readyState,
          checked: [...document.querySelectorAll('div[aria-checked="true"]')].map(e => e.getAttribute('aria-label')),
          inputs: [...document.querySelectorAll('input.whsOnd.zHQkBf')].map(e => e.value),
          dialogs: [...document.querySelectorAll('[role=dialog],[role=alertdialog]')].map(e => e.innerText.slice(0, 300)),
          pickerIframes: [...document.querySelectorAll('iframe[allow*=camera]')].map(e => e.checkVisibility()),
          uploadedFiles: [...document.querySelectorAll('[aria-label="Remover arquivo"]')].length,
          visibility: document.visibilityState,
          hasFocus: document.hasFocus(),
          eventos: window.__ev,
          avisos: [...document.querySelectorAll('[role=alert],[role=status],.RHiWt')].map(e => e.innerText).filter(Boolean),
          botaoEnviar: (() => { const b = [...document.querySelectorAll('span.NPEfkd')].find(e => e.innerText === 'Enviar')?.closest('[role=button]'); return b && { ariaDisabled: b.getAttribute('aria-disabled'), cls: b.className, rect: b.getBoundingClientRect().toJSON() } })(),
        }`),
      )
      const handles = await safe(() => driver.getAllWindowHandles())
      const text = [
        `nome: ${nome}`,
        `tentativa: ${attempt}`,
        `etapa: ${currentStep || '(antes das etapas)'}`,
        `abas abertas: ${Array.isArray(handles) ? handles.length : handles}`,
        `erro: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
        `estado: ${JSON.stringify(state, null, 2)}`,
      ].join('\n')
      writeFileSync(path.join(dir, 'error.txt'), text)
      const png = await safe(() => driver.takeScreenshot())
      if (typeof png === 'string' && !png.startsWith('<')) writeFileSync(path.join(dir, 'screenshot.png'), png, 'base64')
      const html = await safe(() => driver.getPageSource())
      writeFileSync(path.join(dir, 'page.html'), String(html))
      log(`  detalhes do erro salvos em ${dir}`)
    } catch (err) {
      log(`  não consegui salvar detalhes do erro: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const alreadySubmitted = async () => {
    const url = await driver.getCurrentUrl()
    if (!url.includes('formResponse')) return false
    const body = await driver.findElement(By.css('body')).getText()
    return (
      body.includes('Sua resposta foi registrada') || (await driver.findElements(enviarOutraRespostaXPath)).length > 0
    )
  }

  const clearForm = async () => {
    const inputs = await driver.findElements(By.css(inputSelector))
    for (const input of inputs) await input.clear()
    for (let i = 0; i < 20; i++) {
      const removeFileButton = (await driver.findElements(By.xpath(`//div[@aria-label="Remover arquivo"]`)))[0]
      if (!removeFileButton) break
      await removeFileButton.click()
      await driver.wait(until.stalenessOf(removeFileButton), 5000)
    }
    for (let i = 0; i < 20; i++) {
      const checked = (await driver.findElements(By.xpath(`//div[@aria-checked="true" and @role="checkbox"]`)))[0]
      if (!checked) break
      await checked.click()
      await driver.wait(async () => (await checked.getAttribute('aria-checked')) !== 'true', 5000)
    }
  }

  const enviar = async (dado: (typeof dados)[number]) => {
    await driver.wait(until.elementLocated(By.css(inputSelector)), 15000)
    await driver.wait(async () => (await driver.executeScript('return document.readyState')) === 'complete', 15000)
    await dismissDraftModal()

    await step('limpar formulário', clearForm)
    const [nucleoInput, secretarioInput, contatoInput, filiadoInput, valorInput] = await driver.findElements(
      By.css(inputSelector),
    )
    const valorRadio = await driver.findElement(By.xpath(`//*[text()='${process.env.VALOR_REFERENTE}']`))

    await step('preencher campos', async () => {
      await nucleoInput.sendKeys(process.env.NUCLEO as string)
      await secretarioInput.sendKeys(process.env.NOME_SECRETARIO as string)
      await contatoInput.sendKeys(process.env.CONTATO as string)
      await valorRadio.click()
      await selectInSelectBlock('Selecione o município', process.env.MUNICIPIO as string)
      await filiadoInput.sendKeys(dado.nome)
      await valorInput.sendKeys(`R$ ${parseValor(dado.valor)}`)
      await selectInCheckboxBlock('Informe o mês de referência', process.env.MES as string)
    })
    await assertNoModal()

    // radio + mês: qualquer outra coisa marcada é resíduo do rascunho (aria-checked atualiza com atraso)
    const countChecked = async () => (await driver.findElements(By.xpath(`//div[@aria-checked="true"]`))).length
    await driver.wait(async () => (await countChecked()) === 2, 5000).catch(() => undefined)
    const checkedCount = await countChecked()
    if (checkedCount !== 2) throw new RetryError(`esperava 2 opções marcadas, achei ${checkedCount}`)

    await step('upload do comprovante', async () => {
      // picker só abre com a aba em primeiro plano e focada; aba aberta via window.open fica em segundo plano
      await (driver as any).sendDevToolsCommand('Page.bringToFront', {})
      await driver.findElement(By.css(fileButtonSelector)).click()
      await driver.wait(until.elementLocated(iFrameXPath), 15000, 'iframe do picker não apareceu')
      const uploadDialogIFrame = (await driver.findElements(iFrameXPath)).at(-1)!
      await driver.switchTo().frame(uploadDialogIFrame)
      await driver.wait(
        until.elementLocated(By.xpath('//span[text()="Procurar"]')),
        15000,
        'botão Procurar não apareceu',
      )
      await driver.switchTo().defaultContent()
      const pickerClosed = async () => {
        // só o último iframe é o picker atual; os anteriores ficam ocultos no DOM
        const frame = (await driver.findElements(iFrameXPath)).at(-1)
        return !frame || !(await frame.isDisplayed())
      }
      // sem sinal no DOM de que o picker está pronto: setar o arquivo antes disso é ignorado, então espera 1s
      // e, se o picker não fechar, tenta de novo. sendKeys não dispara o change do picker no Brave; via CDP funciona
      await driver.sleep(1000)
      const filePath = path.resolve(`./comprovantes/${dado.comprovante}`)
      for (let tentativa = 1; tentativa <= 3 && !(await pickerClosed()); tentativa++) {
        await setFileViaCdp(filePath).catch((e) => log(`  setFileViaCdp: ${e.message}`)) // sem input = picker já fechou
        await driver.wait(pickerClosed, 8000).catch(() => undefined)
      }
      // picker fecha sozinho após o upload; xpath antigo pegava um <iframe> invisível (opacity 0) e passava direto
      await driver.wait(pickerClosed, 60000, 'Dialog de upload não fechou')
    })
    await assertNoModal()

    await step('enviar', async () => {
      // dump do Davi: aba com visibilityState=hidden e hasFocus=false na hora do envio, e o clique não submeteu
      await (driver as any).sendDevToolsCommand('Page.bringToFront', {})
      const enviarButton = await driver.findElement(
        By.xpath('//span[contains(@class, "NPEfkd") and text()="Enviar"]/../..'),
      )
      await driver.executeScript('arguments[0].scrollIntoView({block: "center"})', enviarButton)
      // após o picker fechar o foco fica no campo do comprovante; o 1º clique em Enviar pode só tirar esse foco
      // (blur/re-render) e ser perdido. Tira o foco antes e loga quem estava focado
      const focado = await driver.executeScript(
        `const a = document.activeElement; const d = a ? (a.getAttribute('aria-label') || a.className || a.tagName).toString().slice(0, 60) : 'nenhum'; if (a && a !== document.body) a.blur(); return d`,
      )
      log(`  elemento focado antes do clique: ${focado}`)
      await driver.wait(async () => (await driver.executeScript('return document.activeElement === document.body')) === true, 2000).catch(() => undefined)
      // tooltip do chip do comprovante (hover/foco) faz o clique em Enviar ser ignorado. Clica numa margem vazia da
      // página: tira o foco do chip e move o mouse para longe dele, o que fecha o tooltip
      await driver.actions().move({ x: 5, y: 5 }).click().perform()
      await driver
        .wait(
          async () =>
            (await driver.executeScript(
              `return ![...document.querySelectorAll('[role=tooltip]')].some((e) => e.checkVisibility()) && document.activeElement === document.body`,
            )) === true,
          3000,
        )
        .catch(() => log('  aviso: tooltip/foco ainda presente após clicar fora'))
      log(
        `  estado antes do clique: ${await driver.executeScript(
          'return document.visibilityState + " focus=" + document.hasFocus()',
        )}`,
      )
      // diagnóstico: registra se o clique/submit chegou na página e qualquer aviso/erro que apareça depois
      await driver.executeScript(`
        window.__ev = []
        const t0 = Date.now()
        const add = (m) => window.__ev.push((Date.now() - t0) + 'ms ' + m)
        for (const type of ['click', 'submit']) document.addEventListener(type, (e) => add(type + ' em ' + (e.target.innerText || e.target.className || e.target.tagName).toString().slice(0, 40)), true)
        window.addEventListener('beforeunload', () => add('beforeunload'))
        new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => n.innerText && /erro|tente|falha|algo deu errado|obrigat|inválid/i.test(n.innerText) && add('aviso: ' + n.innerText.slice(0, 120))))).observe(document.body, { childList: true, subtree: true })
      `)
      // dumps do Gabriel/Davi: o clique chega no botão ("click em Enviar") mas o form às vezes o ignora (sem submit,
      // sem unload, sem aviso). Reclica só se comprovadamente nada foi submetido, para não duplicar a resposta
      const submitStarted = () =>
        driver.executeScript(
          `return location.href.includes('formResponse') || (window.__ev || []).some((e) => /submit|beforeunload/.test(e))`,
        ) as Promise<boolean>
      for (let clique = 1; clique <= 3; clique++) {
        if (clique > 1) {
          if (await submitStarted()) break
          log(`  clique ignorado pelo form, reclicando (${clique}/3)`)
          await (driver as any).sendDevToolsCommand('Page.bringToFront', {})
          await driver.executeScript('arguments[0].click()', enviarButton)
        } else {
          await enviarButton.click()
        }
        try {
          await driver.wait(until.elementLocated(enviarOutraRespostaXPath), 8000)
          return
        } catch {
          if (await dismissDraftModal()) throw new RetryError('modal de rascunho apareceu ao enviar')
        }
      }
      // espera final: o submit pode estar em andamento
      try {
        await driver.wait(until.elementLocated(enviarOutraRespostaXPath), 20000)
      } catch {
        throw new RetryError('"Enviar outra resposta" não apareceu após o envio')
      }
    })
  }

  const enviados: string[] = []
  try {
    for (const dado of dados) {
      let ok = false
      for (let attempt = 1; attempt <= maxAttempts && !ok; attempt++) {
        log(`▶ ${dado.nome} (tentativa ${attempt}/${maxAttempts})`)
        try {
          currentStep = ''
          await driver.switchTo().defaultContent()
          if (attempt > 1 || !(await driver.getCurrentUrl()).startsWith(process.env.URL as string)) {
            await driver.get(process.env.URL as string)
          }
          await enviar(dado)
          ok = true
        } catch (e) {
          const message = e instanceof Error ? e.message.split('\n')[0] : String(e)
          log(`⚠ falha em ${dado.nome} (etapa: ${currentStep}): ${message}`)
          await driver
            .switchTo()
            .defaultContent()
            .catch(() => undefined)
          await dumpError(e, dado.nome, attempt)
          // só reenvia se a tentativa anterior comprovadamente não foi registrada
          if (await alreadySubmitted().catch(() => false)) {
            log(`já registrado: ${dado.nome}, não reenviando`)
            ok = true
          }
        }
      }
      if (!ok) throw new Error(`falhou após ${maxAttempts} tentativas: ${dado.nome}`)
      enviados.push(dado.nome)
      await driver.get(process.env.URL as string)
      log(`✅ ${dado.nome}`)
    }
    log('Todos os formulários enviados com sucesso')
  } catch (e) {
    console.error(e)
    log(`ERRO: ${e instanceof Error ? e.message : String(e)}`)
    await dumpError(e, 'erro-final', 0)
    if (enviados.length > 0) {
      log('-----------------------')
      log(`Já enviados nesta execução (remova do dados.json e dos comprovantes): ${enviados.join(', ')}`)
    }
  }
})()
