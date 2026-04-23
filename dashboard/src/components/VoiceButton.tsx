// dashboard/src/components/VoiceButton.tsx
//
// Pure presentational component — no side effects, no hooks beyond prop consumption.
// All state lives in useVoice (D-01, D-02, D-03). This component renders one of
// four mutually exclusive visual states driven entirely by props (VOICE-UI-02).

import { Loader2, Mic, Volume2 } from 'lucide-react'
import type { VoiceState } from '../hooks/voice-fsm'

export interface VoiceButtonProps {
  state: VoiceState
  voiceActive: boolean
  onToggle: () => void
  disabled?: boolean
}

// Exactly matches the Paperclip button at ConversationsPage.tsx line 906.
const OFF_CLASSES = 'pl-0 pr-1 py-2.5 text-zinc-500 hover:text-zinc-300 disabled:opacity-40 transition-colors'

function ariaLabelFor(voiceActive: boolean, state: VoiceState): string {
  if (!voiceActive) return 'Activate voice mode'
  switch (state) {
    case 'idle':       return 'Voice mode on — waiting for speech'
    case 'listening':  return 'Voice mode — listening'
    case 'processing': return 'Voice mode — processing'
    case 'speaking':   return 'Voice mode — assistant speaking'
  }
}

export function VoiceButton({ state, voiceActive, onToggle, disabled = false }: VoiceButtonProps): JSX.Element {
  const handleClick = (): void => {
    if (disabled) return
    onToggle()
  }

  // --- OFF state (voice mode not active) -----------------------------------
  if (!voiceActive) {
    return (
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled}
        aria-label={ariaLabelFor(false, state)}
        className={OFF_CLASSES}
        title="Activate voice mode"
      >
        <Mic size={16} />
      </button>
    )
  }

  // --- Voice-active states -------------------------------------------------
  // Wrapper applies the baseline Paperclip-sized box; inner renders per state.
  const commonButtonClass =
    'relative pl-0 pr-1 py-2.5 disabled:opacity-40 transition-colors text-[var(--accent)]'

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      aria-label={ariaLabelFor(true, state)}
      className={commonButtonClass}
      title={ariaLabelFor(true, state)}
    >
      {state === 'idle' && (
        <span className="relative inline-flex items-center justify-center">
          <span
            aria-hidden="true"
            className="absolute inset-[-4px] rounded-full ring-2 ring-[var(--accent)] opacity-70 animate-pulse"
          />
          <Mic size={16} />
        </span>
      )}

      {state === 'listening' && (
        <span className="relative inline-flex items-center justify-center">
          <Mic size={16} className="scale-110 animate-pulse" />
        </span>
      )}

      {state === 'processing' && (
        <span className="relative inline-flex items-center justify-center">
          <Mic size={16} />
          <span
            aria-hidden="true"
            className="absolute inset-[-6px] inline-flex items-center justify-center"
          >
            <Loader2 size={24} className="animate-spin text-[var(--accent)]" />
          </span>
        </span>
      )}

      {state === 'speaking' && (
        <span className="inline-flex items-center gap-1">
          <Volume2 size={16} />
          <span aria-hidden="true" className="inline-flex items-end gap-0.5 h-4">
            {[0, 1, 2, 3].map((i) => (
              <span
                key={i}
                className="w-[2px] bg-[var(--accent)] animate-pulse"
                style={{
                  height: `${6 + (i % 2) * 4}px`,
                  animationDelay: `${i * 120}ms`,
                  animationDuration: '600ms',
                }}
              />
            ))}
          </span>
        </span>
      )}
    </button>
  )
}
