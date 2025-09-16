import { Builder, By, until } from 'selenium-webdriver'
import chrome from 'selenium-webdriver/chrome'
import path from 'path'
import dados from './dados.json'
import { checkData, checkEnv } from './utils'
import { config } from 'dotenv'
;(async () => {
  config()
  checkEnv(process.env)
  await checkData(dados)

  const inputSelector = 'input.whsOnd.zHQkBf'
  const selectOptionsSelector = 'div.OA0qNb.ncFHed.QXL7Te'
  const fileButtonSelector = 'div.uArJ5e.cd29Sd'
  const iFrameXPath = By.xpath(`//iframe[@allow="camera 'src' https://docs.google.com"]`)
  const options = new chrome.Options()
  options.debuggerAddress('localhost:9222')
  options.addArguments(
    '--disable-blink-features=AutomationControlled',
    '--disable-infobars',
    '--disable-web-security',
    '--allow-running-insecure-content',
    '--disable-site-isolation-trials',
    '--no-sandbox',
    '--disable-dev-shm-usage',
  )

  const driver = await new Builder().forBrowser('chrome').setChromeOptions(options).build()
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

  const parseValor = (valor: string) => {
    if (valor.includes(',')) {
      const split = valor.split(',')
      if (split[1].length === 0) return `${split[0]},00`
      if (split[1].length === 1) return `${split[0]},${split[1]}0}`
      return valor
    }
    return `${valor},00`
  }

  let index = 0
  try {
    for (const dado of dados) {
      await driver.sleep(2000)
      await driver.wait(until.elementLocated(By.css(inputSelector)))
      const [nucleoInput, secretarioInput, contatoInput, filiadoInput, valorInput] = await driver.findElements(
        By.css(inputSelector),
      )
      const removeFileButton = (await driver.findElements(By.xpath(`//div[@aria-label="Remover arquivo"]`)))[0]
      const valorRadio = await driver.findElement(By.xpath(`//*[text()='${process.env.VALOR_REFERENTE}']`))
      const checkedElements = await driver.findElements(By.xpath(`//div[@aria-checked="true"]`))

      await nucleoInput.clear()
      await secretarioInput.clear()
      await contatoInput.clear()
      await filiadoInput.clear()
      await valorInput.clear()
      if (removeFileButton) await removeFileButton.click()
      if (checkedElements.length) checkedElements.forEach((element) => element.click())

      await nucleoInput.sendKeys(process.env.NUCLEO as string)
      await secretarioInput.sendKeys(process.env.NOME_SECRETARIO as string)
      await contatoInput.sendKeys(process.env.CONTATO as string)
      await valorRadio.click()
      await selectInSelectBlock('Selecione o município', process.env.MUNICIPIO as string)
      await filiadoInput.sendKeys(dado.nome)
      await valorInput.sendKeys(`R$ ${parseValor(dado.valor)}`)
      await selectInCheckboxBlock('Informe o mês de referência', process.env.MES as string)

      await driver.findElement(By.css(fileButtonSelector)).click()
      await driver.wait(until.elementLocated(iFrameXPath))
      const uploadDialogIFrame = await driver.findElement(iFrameXPath)
      await driver.switchTo().frame(uploadDialogIFrame)
      await driver.wait(until.elementLocated(By.xpath('//span[text()="Procurar"]')))
      const inputFile = await driver.findElement(
        By.xpath(`//div[contains(@class, 'VfPpkd-dgl2Hf-ppHlrf-sM5MNb')]/following-sibling::input[@type='file'][1]`),
      )

      const filePath = path.resolve(`./comprovantes/${dado.comprovante}`)
      await inputFile.sendKeys(filePath)

      await driver.switchTo().defaultContent()
      const overlay = await driver.findElement(By.xpath('//div[contains(@class, "XKSfm-Sx9Kwc-xJ5Hnf")]'))
      await driver.wait(until.elementIsNotVisible(overlay))

      await driver.findElement(By.xpath('//span[contains(@class, "NPEfkd") and text()="Enviar"]/../..')).click()

      await driver.wait(until.elementLocated(By.xpath('//a[text()="Enviar outra resposta"]')))
      await driver.get(process.env.URL as string)
      index += 1
      console.log(`✅ ${dado.nome}`)
    }
    console.log('Todos os formulários enviados com sucesso')
  } catch (e) {
    console.error(e)
    if (index > 0) {
      console.log('-----------------------')
      console.log(`
      Erro. As ${index} primeiras entradas já foram enviadas.\n
      Remova-as do seu data.json para evitar envios duplicados.\n
      E por favor, comunique o erro ao responsável.
      `)
    }
  }
})()
