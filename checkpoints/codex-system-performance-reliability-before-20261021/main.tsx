import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './AuthApp'
import './styles.css'

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(error => {
      console.error('Social Land could not register its offline app shell.', error)
    })
  }, { once: true })
}

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
