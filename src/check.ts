import { config } from 'dotenv'
import { checkData, checkEnv, checkEnvMonth } from './utils'
import dados from '../dados.json'

const init = async () => {
  config()
  checkEnv(process.env)
  await checkData(dados)
  checkEnvMonth(process.env)
}

init()
