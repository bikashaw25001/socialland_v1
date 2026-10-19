import 'dotenv/config'
import { spawn } from 'node:child_process'
import path from 'node:path'

const port = Number(process.env.PORT || 3001)
const deadline = Date.now() + 30_000
let vite
let stopping = false

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitForApi() {
  while (!stopping && Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) })
      if (response.ok) return
    } catch {}
    await delay(300)
  }
  throw new Error(`The API did not become ready on port ${port} within 30 seconds.`)
}

function stop(signal) {
  stopping = true
  vite?.kill(signal)
}

process.on('SIGINT', () => stop('SIGINT'))
process.on('SIGTERM', () => stop('SIGTERM'))

try {
  await waitForApi()
  if (stopping) process.exit(0)
  console.log('API is ready; starting the Social Land web app.')
  vite = spawn(process.execPath, [path.resolve('node_modules/vite/bin/vite.js'), '--host', '0.0.0.0'], { stdio: 'inherit', env: process.env })
  vite.on('error', error => { console.error('Could not start Vite:', error.message); process.exitCode = 1 })
  vite.on('exit', code => { process.exitCode = code ?? 0 })
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
