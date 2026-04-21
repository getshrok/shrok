import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from './api'

const AssistantNameContext = createContext('Shrok')

export function AssistantNameProvider({ children }: { children: ReactNode }) {
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.settings.get })
  const [name, setName] = useState('Shrok')

  useEffect(() => {
    if (settings?.assistantName) setName(settings.assistantName)
  }, [settings?.assistantName])

  useEffect(() => { document.title = name }, [name])

  return <AssistantNameContext.Provider value={name}>{children}</AssistantNameContext.Provider>
}

export const useAssistantName = () => useContext(AssistantNameContext)
