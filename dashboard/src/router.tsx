import { createBrowserRouter, RouterProvider, Outlet, useRouteError } from 'react-router-dom'
import { ProtectedRoute } from './auth/ProtectedRoute'
import { AuthProvider } from './auth/AuthContext'
import { ModeProvider } from './context/ModeContext'
import AppShell from './components/layout/AppShell'
import LoginPage from './pages/LoginPage'
import ConversationsPage from './pages/ConversationsPage'
import UsagePage from './pages/UsagePage'
import LogsPage from './pages/LogsPage'
import MemoryPage from './pages/MemoryPage'
import IdentityPage from './pages/IdentityPage'
import SkillsPage from './pages/SkillsPage'
import TasksPage from './pages/TasksPage'
import DocsPage from './pages/DocsPage'
import SchedulesPage from './pages/SchedulesPage'
import TestsPage from './pages/TestsPage'
import EvalsPage from './pages/EvalsPage'

function RootErrorFallback() {
  const error = useRouteError()
  const message = error instanceof Error ? error.message : 'Unknown error'
  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-8">
      <div className="max-w-md w-full text-center space-y-4">
        <h1 className="text-lg font-semibold text-zinc-100">Something went wrong</h1>
        <p className="text-sm text-zinc-400">{message}</p>
        <div className="flex gap-3 justify-center pt-2">
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 rounded text-sm font-medium bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
          >
            Reload
          </button>
          <button
            onClick={() => { window.location.href = '/' }}
            className="px-4 py-2 rounded text-sm font-medium bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
          >
            Go home
          </button>
        </div>
      </div>
    </div>
  )
}

function Providers() {
  return (
    <AuthProvider>
      <ModeProvider>
        <Outlet />
      </ModeProvider>
    </AuthProvider>
  )
}

const router = createBrowserRouter([
  {
    element: <Providers />,
    errorElement: <RootErrorFallback />,
    children: [
      { path: '/login', element: <LoginPage /> },
      {
        element: <ProtectedRoute />,
        children: [
          {
            element: <AppShell />,
            children: [
              { path: '/', element: <ConversationsPage /> },
              { path: '/usage', element: <UsagePage /> },
              { path: '/logs', element: <LogsPage /> },
              { path: '/memory', element: <MemoryPage /> },
              { path: '/docs', element: <DocsPage /> },
              { path: '/identity', element: <IdentityPage /> },
              { path: '/skills', element: <SkillsPage /> },
              { path: '/tasks', element: <TasksPage /> },
              { path: '/schedules', element: <SchedulesPage /> },
              { path: '/tests', element: <TestsPage /> },
              { path: '/evals', element: <EvalsPage /> },
            ],
          },
        ],
      },
    ],
  },
])

export function AppRouter() {
  return <RouterProvider router={router} />
}
