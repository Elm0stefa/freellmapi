import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { CommandCenter } from '@/components/CommandCenter'

export function App() {
  const [client] = useState(() => new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000 } },
  }))
  return (
    <QueryClientProvider client={client}>
      <CommandCenter />
    </QueryClientProvider>
  )
}
