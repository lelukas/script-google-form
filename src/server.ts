import express from 'express'
import cors from 'cors'
import path from 'path'

const app = express()
const PORT = 3000

app.use(cors())
app.use(express.json())
app.use(express.static(path.join(__dirname, '../dist')))

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../dist/index.html'))
})

app.listen(PORT, () => {
  console.log(`📋 Servidor do formulário: http://localhost:${PORT}`)
})
