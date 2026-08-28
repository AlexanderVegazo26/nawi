import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { startThemeSync } from './lib/theme'
import './styles.css'

// Resolve the persisted theme before the first render. Doing this in an effect
// instead would paint the OS theme and then swap, which is a visible flash.
// A failure here must never stop the app mounting, so render either way.
void startThemeSync()
  .catch(() => undefined)
  .finally(() => {
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <App />
      </StrictMode>
    )
  })
