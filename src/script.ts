import { Builder, By, until } from 'selenium-webdriver'
import chrome from 'selenium-webdriver/chrome'
import path from 'path'
import { appendFileSync } from 'fs'
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
  const iFrameXPath = By.xpath(`//iframe[@allow="camera 'src' https://docs.google.com"]`)
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
    await driver.sleep(500)
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
        ws.send(JSON.stringify({ id: i, method, params }))
      })
    try {
      const { root } = await send('DOM.getDocument', { depth: -1, pierce: true })
      const [input] = findFileInputs(root)
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
    await driver.sleep(1500)
    return true
  }

  const assertNoModal = async () => {
    if (await dismissDraftModal()) throw new RetryError('modal de rascunho apareceu durante o preenchimento')
  }

  const step = async <T>(name: string, fn: () => Promise<T>) => {
    log(`  · ${name}`)
    return fn()
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
      await driver.sleep(500)
    }
    for (let i = 0; i < 20; i++) {
      const checked = (await driver.findElements(By.xpath(`//div[@aria-checked="true" and @role="checkbox"]`)))[0]
      if (!checked) break
      await checked.click()
      await driver.sleep(300)
    }
  }

  const enviar = async (dado: (typeof dados)[number]) => {
    await driver.wait(until.elementLocated(By.css(inputSelector)), 15000)
    await driver.sleep(2000)
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
      await driver.findElement(By.css(fileButtonSelector)).click()
      await driver.wait(until.elementLocated(iFrameXPath))
      const uploadDialogIFrame = await driver.findElement(iFrameXPath)
      await driver.switchTo().frame(uploadDialogIFrame)
      await driver.wait(until.elementLocated(By.xpath('//span[text()="Procurar"]')))
      await driver.sleep(2000) // picker anexa os handlers depois de renderizar; setar antes é ignorado
      // sendKeys não dispara o change do picker no Brave; setar via CDP funciona
      await setFileViaCdp(path.resolve(`./comprovantes/${dado.comprovante}`))
      await driver.switchTo().defaultContent()
      // picker fecha sozinho após o upload; xpath antigo pegava um <iframe> invisível (opacity 0) e passava direto
      await driver.wait(
        async () => {
          const frames = await driver.findElements(iFrameXPath)
          return !frames.length || !(await frames[0].isDisplayed())
        },
        60000,
        'Dialog de upload não fechou',
      )
    })
    await assertNoModal()

    await step('enviar', async () => {
      await driver.findElement(By.xpath('//span[contains(@class, "NPEfkd") and text()="Enviar"]/../..')).click()
      try {
        await driver.wait(until.elementLocated(enviarOutraRespostaXPath), 20000)
      } catch {
        await dismissDraftModal()
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
          await driver.switchTo().defaultContent()
          if (attempt > 1 || !(await driver.getCurrentUrl()).startsWith(process.env.URL as string)) {
            await driver.get(process.env.URL as string)
          }
          await enviar(dado)
          ok = true
        } catch (e) {
          const message = e instanceof Error ? e.message.split('\n')[0] : String(e)
          log(`⚠ falha em ${dado.nome}: ${message}`)
          await driver
            .switchTo()
            .defaultContent()
            .catch(() => undefined)
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
    if (enviados.length > 0) {
      log('-----------------------')
      log(`Já enviados nesta execução (remova do dados.json e dos comprovantes): ${enviados.join(', ')}`)
    }
  }
})()
