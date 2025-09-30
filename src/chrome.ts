import { exec } from 'child_process'
import path from 'path'
import os from 'os'
import { config } from 'dotenv'

config()
const chromePath = process.env.CHROME_PATH

if (!chromePath) {
  console.error('❌ Caminho do Chrome não definido no .env (CHROME_PATH).')
  process.exit(1)
}

const platform = os.platform()
const isWindows = platform === 'win32'
const userDataDir = path.resolve(isWindows ? 'C:/tmp/chrome-debug' : '/tmp/chrome-debug')
const command = `"${chromePath}" --remote-debugging-port=9222 --user-data-dir="${userDataDir}"`

exec(command, (error) => {
  if (error) console.error(error)
})
