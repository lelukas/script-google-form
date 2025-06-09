import path from 'path'
import fs from 'fs/promises'

interface Dado {
  nome: string
  valor: string
  comprovante: string
}

const isValorFieldValid = (value: string) => {
  const parsedValue = value.replace(',', '.')
  const isNaN = Number.isNaN(Number(parsedValue))
  return !isNaN
}

const fileExists = async (fileName: string) => {
  try {
    const filePath = path.resolve(`./comprovantes/${fileName}`)
    await fs.access(filePath)
    return true
  } catch (e) {
    console.error(e)
    return false
  }
}

export const checkData = async (data: Dado[]) => {
  if (data.length === 0) throw new Error('data.json vazio. Preencha-o para continuar.')
  const areAllFieldsFilled = data.every((item) => item.nome && item.valor && item.comprovante)
  if (areAllFieldsFilled) {
    const values = data.map((item) => item.valor)
    const areValorFieldsValid = values.every((item) => isValorFieldValid(item))
    if (areValorFieldsValid) {
      const files = data.map((item) => item.comprovante)
      const fileChecks = await Promise.all(files.map(fileExists))
      const filesExist = fileChecks.every(Boolean)
      if (filesExist) {
        console.log('Arquivo data.json válido. Iniciando automação.')
      } else {
        throw new Error(`
        Detectado arquivo inválido ou inexistente de comprovante.
        Certifique-se que todos os arquivos estejam na pasta 'comprovantes'
        e de escrever seus nomes corretamente.`)
      }
    } else {
      throw new Error(`
      Detectado dado do campo "valor" inválido.
      O dado do campo "valor" deve ser preenchido como "1", "1," ou "1,0".
      Corrija-os e tente novamente.`)
    }
  } else {
    throw new Error('dados.json inválido. Há campos vazios. Preencha-os e tente novamente.')
  }
}

export const checkEnv = (env: NodeJS.ProcessEnv) => {
  const isEnvFilled = Object.values(env).every((key) => key)
  if (!isEnvFilled) {
    throw new Error(`
      Arquivo .env não preenchido corretamente.\n
      Consulte o arquivo README para obter ajuda em como preenchê-lo.
    `)
  }
}
