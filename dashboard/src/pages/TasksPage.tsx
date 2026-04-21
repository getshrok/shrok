import { api } from '../lib/api'
import { KindEditorPage } from '../components/kind/KindEditorPage'

export default function TasksPage() {
  return (
    <KindEditorPage
      kind="task"
      apiClient={api.tasks}
      routeBase="/api/tasks"
      title="Tasks"
      subtitle="Recurring work the assistant runs on a schedule — monitoring, check-ins, reports, and background tasks"
      emptyStateHeading="No tasks yet"
      primaryCta="+ New task"
      createHeading="New Task"
      createButtonLabel="Create task"
      createPendingLabel="Creating…"
      deleteConfirm={(name) => `Delete task "${name}"?`}
      placeholderBody="Select a task or create a new one"
    />
  )
}
