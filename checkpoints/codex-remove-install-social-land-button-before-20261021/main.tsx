import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './AuthApp'
import './styles.css'

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

function PwaInstallControl() {
  const [installPrompt, setInstallPrompt] = React.useState<BeforeInstallPromptEvent | null>(null)

  React.useEffect(() => {
    const onInstallAvailable = (event: Event) => {
      event.preventDefault()
      setInstallPrompt(event as BeforeInstallPromptEvent)
    }
    const onInstalled = () => setInstallPrompt(null)
    window.addEventListener('beforeinstallprompt', onInstallAvailable)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onInstallAvailable)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  if (!installPrompt) return null
  return <button className="pwa-install-control" type="button" onClick={async () => {
    await installPrompt.prompt()
    await installPrompt.userChoice
    setInstallPrompt(null)
  }}>Install Social Land</button>
}

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(error => {
      console.error('Social Land could not register its offline app shell.', error)
    })
  }, { once: true })
}

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /><PwaInstallControl /></React.StrictMode>)
