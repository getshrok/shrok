import { note, password, select, spinner } from '@clack/prompts'
import type { WizardContext } from './types.js'
import { assertNotCancelled } from './utils.js'

export async function setupLlm(ctx: WizardContext): Promise<void> {
  const { deps, existingEnv, secrets } = ctx

  note('Shrok needs an AI provider to think and respond.', '1/5  AI provider')

  const llmProvider = assertNotCancelled(await select({
    message: 'Which AI provider would you like to use?',
    options: [
      { value: 'anthropic',   label: 'Anthropic - Claude',              hint: 'Recommended · Pay-per-token' },
      { value: 'gemini',      label: 'Google - Gemini',                 hint: 'Pay-per-token' },
      { value: 'openai',      label: 'OpenAI - API key',                hint: 'Pay-per-token' },
    ],
    initialValue: existingEnv['LLM_PROVIDER'] ?? 'anthropic',
  }))
  secrets['LLM_PROVIDER'] = llmProvider

  // ── API key flow ──────────────────────────────────────────────────────────
  const llmEnvVar = llmProvider === 'anthropic' ? 'ANTHROPIC_API_KEY'
    : llmProvider === 'gemini' ? 'GEMINI_API_KEY'
    : 'OPENAI_API_KEY'

  const llmKeyLabel = llmProvider === 'anthropic' ? 'Paste your Anthropic API key:'
    : llmProvider === 'gemini' ? 'Paste your Google Gemini API key:'
    : 'Paste your OpenAI API key:'

  const llmInstructions: Record<string, string> = {
    anthropic: [
      '1. Go to https://console.anthropic.com and create an account (or sign in).',
      '2. Go to Settings → Billing and add a payment method.',
      '3. Refresh the page, then click Edit near where it says auto reload is disabled.',
      '4. Set up the auto reload (minimum amounts are fine).',
      '5. Go to API Keys in the sidebar, click + Create Key, and give it a name.',
      '6. Copy the key immediately, it\'s only shown once. Store it somewhere secure.',
    ].join('\n'),
    gemini: [
      '1. Go to aistudio.google.com and sign in with your Google account.',
      '2. If it\'s your first visit, accept the Generative AI terms of service and confirm your region.',
      '3. Click "Get API key" in the left sidebar. For new users, a default project and key are created automatically, otherwise you\'ll need to create or import a project.',
      '4. Copy your key (starts with AIza).',
    ].join('\n'),
    openai: [
      '1. Go to https://platform.openai.com and sign up (or log in).',
      '(Note: this is separate from a ChatGPT account.)',
      '2. If prompted, create an organization and a project.',
      '3. Go to Billing in the left menu, add a payment method, and load a small amount of credit.',
      '4. Go to Settings → API Keys → Create new secret key.',
      '5. Copy the key immediately, you won\'t be able to see it again.',
    ].join('\n'),
  }

  note(llmInstructions[llmProvider]!, 'How to get your API key')

  if (llmProvider === 'anthropic') {
    note(
      'New accounts start on Tier 1, which limits throughput to ~30k tokens/min.\n' +
      'This can cause noticeably slow responses. After ~$40 in total API spend,\n' +
      'your account upgrades to Tier 2 (450k tokens/min) and delays go away.\n' +
      'You can reach this immediately by pre-purchasing credits at\n' +
      'console.anthropic.com → Settings → Billing.\n' +
      '\n' +
      'There is also a default $100/month spend cap. If you plan to use heavier\n' +
      'cost profiles, raise it at https://console.anthropic.com → Settings → Limits.',
      'Anthropic rate limits'
    )
  }

  const llmKey = assertNotCancelled(await password({ message: llmKeyLabel, mask: '*' }))
  if (llmKey) secrets[llmEnvVar] = llmKey

  // Validate key - retry loop
  const s1 = spinner()
  let keyOk = false
  while (!keyOk) {
    s1.start('Checking your API key…')
    try {
      deps.execSync('node --import tsx/esm scripts/test-llm.ts', {
        cwd: deps.paths.root,
        stdio: 'pipe',
        env: { ...process.env, ...secrets, LLM_PROVIDER: llmProvider },
      })
      s1.stop('API key OK')
      keyOk = true
    } catch (e: unknown) {
      const exitCode = (e as { status?: number }).status
      const stderr = (e as { stderr?: Buffer }).stderr?.toString().trim() ?? ''
      // On Windows, libuv can crash during cleanup even when the test passed.
      // If exit code is 0 or stderr is just a libuv assertion, treat as success.
      if (exitCode === 0 || /UV_HANDLE_CLOSING|Assertion failed.*uv/i.test(stderr)) {
        s1.stop('API key OK')
        keyOk = true
        continue
      }
      s1.stop(`Could not reach the AI provider${stderr ? ` - ${stderr}` : ''}`)
      const decision = assertNotCancelled(await select({
        message: 'What would you like to do?',
        options: [
          { value: 'retry', label: 'Try again' },
          { value: 'skip',  label: 'Skip for now and continue' },
        ],
        initialValue: 'retry',
      }))
      if (decision === 'skip') break
      const newKey = assertNotCancelled(await password({ message: llmKeyLabel, mask: '*' }))
      if (newKey) secrets[llmEnvVar] = newKey
    }
  }
}
