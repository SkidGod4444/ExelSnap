import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { TooltipProvider } from '@/components/ui/tooltip'
import './styles/tailwind.css'

if (window.api.platform === 'darwin') document.body.classList.add('mac')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TooltipProvider>
      <App />
    </TooltipProvider>
  </StrictMode>
)
