import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useMode } from '../context/ModeContext'
import { useAssistantName } from '../lib/assistant-name'
import { useUnsavedGuard, confirmIfDirty } from '../hooks/useUnsavedGuard'
import type { IdentityFile } from '../types/api'

const warnings = (name: string): Record<string, string> => ({
  'main/SYSTEM.md': `This is the core system prompt. Changes affect how ${name} behaves at a fundamental level.`,
  'main/BOOTSTRAP.md': `Bootstrap instructions run during onboarding. After ${name} completes its first-run questioning, this file should be blank — if it still has content, it will re-run the onboarding flow.`,
  'agent/SYSTEM.md': `This is the system prompt for all sub-agents. Changes affect every agent ${name} spawns.`,
  // Stewards
  'stewards/action-compliance.md': 'Checks whether the head missed a mandatory action (e.g., should have spawned an agent but didn\'t).',
  'stewards/agent-completion.md': 'Classifies an agent\'s final output as a completion or a question needing user input.',
  'stewards/bootstrap.md': 'Checks whether onboarding is complete and nudges the head if BOOTSTRAP.md still has content.',
  'stewards/head-relay.md': 'Post-processes outgoing messages to rewrite internal language (agent leaks, third-person references) into first person before they reach the user.',
  'stewards/message-agent.md': 'Gates message_agent calls — blocks impatient head check-ins on running agents.',
  'stewards/preference.md': 'Detects user preferences that should be saved to USER.md.',
  'stewards/relay.md': 'Decides whether a scheduled agent\'s output is worth surfacing to the user.',
  'stewards/resume.md': 'Gates resume_agent calls — rejects non-answers so the head asks the user instead.',
  'stewards/routing.md': 'Pre-analyzes each incoming message to hint at the best approach — skill to invoke, tool to reach for, or agent to continue — before the head activates.',
  'stewards/skill-choice.md': 'Validates the head chose the right skill for a spawned agent.',
  'stewards/spawn.md': 'Nudges the head if it should have spawned an agent but didn\'t.',
  'stewards/spawn-agent.md': 'Validates spawn_agent calls from sub-agents — checks that the sub-task is well-formed and the requested skill fits before approving the spawn.',
  'stewards/work-summary.md': 'Summarizes an agent\'s work history so the head gets signal instead of raw tool dumps.',
  // Proactive
  'proactive/tasks.md': 'Decides whether a scheduled task should run or be skipped based on user context.',
  'proactive/reminder.md': 'Decides whether a triggered reminder should be surfaced to the user based on recent conversation.',
})

function fileKey(f: IdentityFile) {
  return `${f.section}/${f.filename}`
}

export default function IdentityPage() {
  const { isDeveloper } = useMode()
  const assistantName = useAssistantName()
  const WARNINGS = warnings(assistantName)
  const qc = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ['identity'],
    queryFn: api.identity.list,
  })

  const saveMutation = useMutation({
    mutationFn: ({ section, filename, content }: { section: 'main' | 'agent' | 'stewards' | 'proactive' | 'memory'; filename: string; content: string }) =>
      api.identity.save(section, filename, content),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['identity'] }),
  })

  const allFiles = data?.files ?? []
  const visibleFiles = allFiles.filter(f => {
    if (f.section === 'stewards' || f.section === 'proactive' || f.section === 'memory') return isDeveloper
    return true
  })

  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [savedContent, setSavedContent] = useState('')

  // Auto-select first visible file once loaded
  useEffect(() => {
    if (visibleFiles.length > 0 && selectedKey === null) {
      const first = visibleFiles[0]!
      setSelectedKey(fileKey(first))
      setDraft(first.content)
      setSavedContent(first.content)
    }
  }, [visibleFiles, selectedKey])

  // When developer mode turns off and selected file becomes hidden, jump to first visible
  useEffect(() => {
    if (selectedKey && !visibleFiles.find(f => fileKey(f) === selectedKey)) {
      const first = visibleFiles[0]
      if (first) {
        setSelectedKey(fileKey(first))
        setDraft(first.content)
        setSavedContent(first.content)
      }
    }
  }, [isDeveloper])

  function selectFile(f: IdentityFile) {
    if (!confirmIfDirty()) return
    setSelectedKey(fileKey(f))
    setDraft(f.content)
    setSavedContent(f.content)
  }

  const selectedFile = allFiles.find(f => fileKey(f) === selectedKey) ?? null
  const isDirty = draft !== savedContent
  useUnsavedGuard(isDirty)

  function handleSave() {
    if (!selectedFile || !isDirty) return
    saveMutation.mutate(
      { section: selectedFile.section, filename: selectedFile.filename, content: draft },
      {
        onSuccess: () => setSavedContent(draft),
      },
    )
  }

  function handleReset() {
    if (!selectedFile) return
    setDraft(savedContent)
  }

  if (isLoading) {
    return <div className="flex items-center justify-center h-full text-sm text-zinc-500">Loading…</div>
  }

  // Group files by section for the file list
  const mainFiles = visibleFiles.filter(f => f.section === 'main')
  const agentFiles = visibleFiles.filter(f => f.section === 'agent')
  const stewardFiles = visibleFiles.filter(f => f.section === 'stewards')
  const proactiveFiles = visibleFiles.filter(f => f.section === 'proactive')
  const memoryFiles = visibleFiles.filter(f => f.section === 'memory')

  const warning = selectedFile ? WARNINGS[fileKey(selectedFile)] : null

  return (
    <div className="h-full flex">
      {/* File list */}
      <div className="w-48 shrink-0 border-r border-zinc-800 flex flex-col overflow-y-auto">
        <div className="px-4 pt-6 pb-3 border-b border-zinc-800 shrink-0">
          <h1 className="text-lg font-semibold text-zinc-100">Identity</h1>
        </div>
        <div className="px-4 py-2 border-b border-zinc-800 shrink-0">
          <p className="text-[11px] text-zinc-500 leading-snug">Personality, knowledge, and system prompts — shapes how the assistant thinks and speaks</p>
        </div>

        <nav className="flex-1 px-2 py-3 space-y-4">
          {mainFiles.length > 0 && (
            <div>
              <div className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Head</div>
              {mainFiles.map(f => (
                <FileListItem
                  key={fileKey(f)}
                  file={f}
                  selected={fileKey(f) === selectedKey}
                  onSelect={() => selectFile(f)}
                />
              ))}
            </div>
          )}

          {agentFiles.length > 0 && (
            <div>
              <div className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Sub-agents</div>
              {agentFiles.map(f => (
                <FileListItem
                  key={fileKey(f)}
                  file={f}
                  selected={fileKey(f) === selectedKey}
                  onSelect={() => selectFile(f)}
                />
              ))}
            </div>
          )}

          {stewardFiles.length > 0 && (
            <div>
              <div className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Stewards</div>
              {stewardFiles.map(f => (
                <FileListItem
                  key={fileKey(f)}
                  file={f}
                  selected={fileKey(f) === selectedKey}
                  onSelect={() => selectFile(f)}
                />
              ))}
            </div>
          )}

          {proactiveFiles.length > 0 && (
            <div>
              <div className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Proactive Agents</div>
              {proactiveFiles.map(f => (
                <FileListItem
                  key={fileKey(f)}
                  file={f}
                  selected={fileKey(f) === selectedKey}
                  onSelect={() => selectFile(f)}
                />
              ))}
            </div>
          )}

          {memoryFiles.length > 0 && (
            <div>
              <div className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Memory</div>
              {memoryFiles.map(f => (
                <FileListItem
                  key={fileKey(f)}
                  file={f}
                  selected={fileKey(f) === selectedKey}
                  onSelect={() => selectFile(f)}
                />
              ))}
            </div>
          )}
        </nav>
      </div>

      {/* Editor */}
      {selectedFile ? (
        <div className="flex-1 flex flex-col min-w-0">
          {/* Editor header */}
          <div className="px-5 py-3 border-b border-zinc-800 flex items-center gap-3 shrink-0">
            <span className="text-sm font-medium text-zinc-100">{selectedFile.filename}</span>
            <div className="flex-1" />
            {isDirty && (
              <button
                onClick={handleReset}
                className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                Reset
              </button>
            )}
            <button
              onClick={handleSave}
              disabled={!isDirty || saveMutation.isPending}
              className="px-3 py-1 rounded text-xs font-medium bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {saveMutation.isPending ? 'Saving…' : isDirty ? 'Save' : 'Saved'}
            </button>
          </div>

          {/* Warning banner */}
          {warning && (
            <div className="mx-5 mt-3 px-3 py-2 bg-amber-950/40 border border-amber-900/50 rounded-md text-xs text-amber-400">
              ⚠ {warning}
            </div>
          )}

          {/* Textarea */}
          <div className="flex-1 p-5 min-h-0">
            <textarea
              value={draft}
              onChange={e => setDraft(e.target.value)}
              className="w-full h-full bg-zinc-900/60 border border-zinc-800 rounded-lg px-4 py-3 text-sm text-zinc-200 font-mono leading-relaxed resize-none focus:outline-none focus:border-zinc-600"
              spellCheck={false}
            />
          </div>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center text-sm text-zinc-500">
          Select a file to edit
        </div>
      )}
    </div>
  )
}

function FileListItem({ file, selected, onSelect }: { file: IdentityFile; selected: boolean; onSelect: () => void }) {
  return (
    <button
      onClick={onSelect}
      className={`w-full text-left px-2 py-1.5 rounded text-xs font-medium transition-colors flex items-center gap-1.5 ${
        selected
          ? 'bg-zinc-800 text-zinc-100'
          : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200'
      }`}
    >
      <span className="truncate flex-1">{file.filename.replace('.md', '')}</span>
      {file.isDangerous && <span className="text-amber-600 text-[11px]">⚠</span>}
      {file.isWorkspace && <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />}
    </button>
  )
}
