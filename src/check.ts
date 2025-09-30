import { config } from 'dotenv'
import { checkData, checkEnv } from './utils'
import dados from '../dados.json'

config()
checkEnv(process.env)
checkData(dados)
