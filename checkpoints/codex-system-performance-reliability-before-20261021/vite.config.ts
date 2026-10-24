import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'

const certDir = path.resolve('.local-https')
const caCert = path.join(certDir, 'local-dev-ca.crt')
const serverCertName = fs.existsSync(certDir)
  ? fs.readdirSync(certDir).find((file) => /^\d+\.\d+\.\d+\.\d+\.crt$/.test(file))
  : undefined
const serverCert = serverCertName ? path.join(certDir, serverCertName) : undefined
const serverKey = serverCertName ? path.join(certDir, serverCertName.replace(/\.crt$/, '.key')) : undefined

export default defineConfig({
  server: {
    host: '0.0.0.0',
    https: serverCert && serverKey && fs.existsSync(serverKey)
      ? { cert: fs.readFileSync(serverCert), key: fs.readFileSync(serverKey) }
      : undefined,
    proxy: { '/api': 'http://localhost:3001', '/uploads': 'http://localhost:3001', '/socket.io': { target: 'http://localhost:3001', ws: true } },
  },
  plugins: [
    react(),
    {
      name: 'local-dev-ca-download',
      configureServer(server) {
        server.middlewares.use('/local-dev-ca.crt', (_request, response) => {
          if (!fs.existsSync(caCert)) {
            response.statusCode = 404
            response.end('Local development certificate has not been created.')
            return
          }
          response.setHeader('Content-Type', 'application/x-x509-ca-cert')
          response.setHeader('Content-Disposition', 'attachment; filename="local-dev-ca.crt"')
          response.end(fs.readFileSync(caCert))
        })
      },
    },
  ],
})
