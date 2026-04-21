import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from './lib/queryClient'
import { AssistantNameProvider } from './lib/assistant-name'
import { ThemeProvider } from './lib/theme'
import App from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <AssistantNameProvider>
          <App />
        </AssistantNameProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </React.StrictMode>,
)
