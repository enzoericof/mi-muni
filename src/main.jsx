import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { AppProvider } from './lib/AppContext'
import './styles.css'

if (typeof window !== 'undefined') {
  const isLocalDevPort = window.location.port === '4173'
  const isLocalhost = window.location.hostname === 'localhost'

  // Google Sign-In local is configured against the loopback origin; normalize localhost automatically.
  if (isLocalDevPort && isLocalhost) {
    const nextUrl = new URL(window.location.href)
    nextUrl.hostname = '127.0.0.1'
    window.location.replace(nextUrl.toString())
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AppProvider>
      <App />
    </AppProvider>
  </React.StrictMode>,
)
