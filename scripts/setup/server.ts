import { note, password, spinner } from '@clack/prompts'
import bcryptjs from 'bcryptjs'
import type { WizardContext } from './types.js'
import { assertNotCancelled } from './utils.js'

export async function setupServer(ctx: WizardContext): Promise<void> {
  const { existingEnv, secrets } = ctx

  // ── Dashboard ─────────────────────────────────────────────────────────────
  note(
    'Shrok runs a web dashboard at http://localhost:8888 — conversation history, agent activity, settings, and logs.\n' +
    'You can also chat with Shrok directly from the dashboard if you don\'t have a channel set up.\n\n' +
    'Set a password to secure it.',
    '5/5  Web dashboard'
  )

  let dashPw = ''
  while (true) {
    if (existingEnv['DASHBOARD_PASSWORD_HASH']) {
      const pw = assertNotCancelled(await password({
        message: 'Dashboard password (leave blank to keep existing):',
        mask: '*',
        validate: (v) => ((v ?? '').length === 0 || (v ?? '').length >= 8) ? undefined : 'Password must be at least 8 characters',
      })) as string
      if (pw.length === 0) break
      const confirm1 = assertNotCancelled(await password({
        message: 'Confirm password:',
        mask: '*',
      })) as string
      if (pw !== confirm1) { note('Passwords did not match, try again.', 'Mismatch'); continue }
      dashPw = pw
      break
    } else {
      const pw = assertNotCancelled(await password({
        message: 'Choose a dashboard password (min 8 characters):',
        mask: '*',
        validate: (v) => ((v ?? '').length >= 8) ? undefined : 'Password must be at least 8 characters',
      })) as string
      const confirm1 = assertNotCancelled(await password({
        message: 'Confirm password:',
        mask: '*',
      })) as string
      if (pw !== confirm1) { note('Passwords did not match, try again.', 'Mismatch'); continue }
      dashPw = pw
      break
    }
  }
  if (dashPw && dashPw.length > 0) {
    const s = spinner()
    s.start('Hashing password…')
    secrets['DASHBOARD_PASSWORD_HASH'] = await bcryptjs.hash(dashPw, 12)
    s.stop('Password set')
  } else {
    secrets['DASHBOARD_PASSWORD_HASH'] = existingEnv['DASHBOARD_PASSWORD_HASH']!
  }
}
