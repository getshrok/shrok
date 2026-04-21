import { api } from '../lib/api'
import { KindEditorPage } from '../components/kind/KindEditorPage'

export default function SkillsPage() {
  return (
    <KindEditorPage
      kind="skill"
      apiClient={api.skills}
      routeBase="/api/skills"
      title="Skills"
      subtitle="Abilities the assistant can use — included in agent system prompts"
      emptyStateHeading="No skills yet"
      primaryCta="+ New"
      createHeading="New Skill"
      createButtonLabel="Create"
      createPendingLabel="Creating..."
      deleteConfirm={(name) => `Delete skill "${name}"?`}
      placeholderBody="Select a skill or create a new one"
    />
  )
}
