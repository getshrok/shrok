import { note, password, select, spinner } from '@clack/prompts'
import type { WizardContext } from './types.js'
import { assertNotCancelled } from './utils.js'

export async function setupSearch(ctx: WizardContext): Promise<void> {
  const { deps, existingEnv, secrets } = ctx

  note('Shrok can search the web when it needs current information.\nBoth options below have a free tier — if you\'re not sure, pick Tavily and follow the link to sign up.', '3/5  Web search')

  const searchProvider = assertNotCancelled(await select({
    message: 'Which web search provider do you have an API key for?  (highly recommended)',
    options: [
      { value: 'tavily', label: 'Tavily',       hint: '1,000 free credits/month · tavily.com' },
      { value: 'brave',  label: 'Brave Search', hint: '~1K free queries/month · api.search.brave.com' },
      { value: 'none',   label: "Skip - I'll set this up later" },
    ],
    initialValue: existingEnv['SEARCH_PROVIDER'] || 'tavily',
  }))

  if (searchProvider !== 'none') {
    secrets['SEARCH_PROVIDER'] = searchProvider
    const searchEnvVar = searchProvider === 'tavily' ? 'TAVILY_API_KEY' : 'BRAVE_API_KEY'
    const searchLabel = searchProvider === 'tavily' ? 'Tavily API key:' : 'Brave Search API key:'

    note(
      searchProvider === 'tavily'
        ? [
            '1. Go to app.tavily.com and create an account (email, Google, or GitHub).',
            '2. During registration you\'ll be asked to set up two-factor authentication.',
            '3. Have an authenticator app ready (e.g. Google Authenticator) to scan the QR code.',
            '4. Once logged in, your API key is on the dashboard. It starts with tvly-.',
            '',
            'Free tier includes 1,000 credits/month. No credit card required.',
          ].join('\n')
        : [
            '1. Go to brave.com/search/api and click Get Started.',
            '2. Create an account and choose a plan.',
            '3. All plans include $5/month in credit (~1,000 queries). A credit card is required.',
            '4. In the dashboard at api-dashboard.search.brave.com, go to API Keys.',
            '5. Create a new key, give it a name, and copy it.',
          ].join('\n'),
      `How to get a ${searchProvider === 'tavily' ? 'Tavily' : 'Brave Search'} API key`
    )

    const searchKey = assertNotCancelled(await password({ message: searchLabel, mask: '*' }))
    if (searchKey) secrets[searchEnvVar] = searchKey

    const sSearch = spinner()
    let searchOk = false
    while (!searchOk) {
      sSearch.start('Checking search key…')
      try {
        const key = secrets[searchEnvVar]
        if (searchProvider === 'tavily') {
          const res = await deps.fetch('https://api.tavily.com/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ api_key: key, query: 'test', max_results: 1 }),
          })
          if (!res.ok) throw new Error(`Tavily returned ${res.status}`)
        } else {
          const res = await deps.fetch('https://api.search.brave.com/res/v1/web/search?q=test&count=1', {
            headers: { Accept: 'application/json', 'X-Subscription-Token': key ?? '' },
          })
          if (!res.ok) throw new Error(`Brave returned ${res.status}`)
        }
        sSearch.stop('Search key OK')
        searchOk = true
      } catch (e: unknown) {
        sSearch.stop(`Could not verify search key - ${(e as Error).message}`)
        const decision = assertNotCancelled(await select({
          message: 'What would you like to do?',
          options: [
            { value: 'retry', label: 'Try again' },
            { value: 'skip',  label: 'Skip verification and continue' },
          ],
          initialValue: 'retry',
        }))
        if (decision === 'skip') break
        const newKey = assertNotCancelled(await password({ message: searchLabel, mask: '*' }))
        if (newKey) secrets[searchEnvVar] = newKey
      }
    }
  } else {
    delete secrets['SEARCH_PROVIDER']
  }
}
