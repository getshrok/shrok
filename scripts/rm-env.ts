/**
 * Tear down a named Shrok environment.
 *
 * Usage:  npm run rm-env <id>
 * Example: npm run rm-env test5
 *
 * Stops the running containers (if they're pointed at this workspace),
 * then deletes ~/.shrok-<id>/.
 *
 * Qdrant/FalkorDB volumes are NOT deleted by default — pass --volumes to also
 * wipe the vector and graph data for this environment's collection/graph.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawnSync, execSync } from 'node:child_process'
import * as url from 'node:url'

const args = process.argv.slice(2)
const id = args.find(a => !a.startsWith('--'))
const wipeVolumes = args.includes('--volumes')

if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
  console.error('Usage: npm run rm-env <id> [--volumes]')
  process.exit(1)
}

const workspacePath = path.join(os.homedir(), `.shrok-${id}`)

// Check if the running shrok container is using this workspace
let containerWorkspace = ''
try {
  const out = execSync(
    `docker inspect shrok-shrok-1 --format '{{range .Mounts}}{{.Source}}:{{.Destination}} {{end}}'`,
    { stdio: ['pipe', 'pipe', 'pipe'] }
  ).toString()
  const match = out.match(/(\S+):\/app\/workspace/)
  if (match) containerWorkspace = match[1]!
} catch { /* container not running */ }

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..')

if (containerWorkspace === workspacePath) {
  console.log(`Stopping containers (mounted to ${id})...`)
  spawnSync('docker', ['compose', wipeVolumes ? 'down' : 'down', ...(wipeVolumes ? ['-v'] : [])], {
    cwd: root,
    stdio: 'inherit',
  })
} else if (containerWorkspace) {
  console.log(`Containers are running a different environment (${path.basename(containerWorkspace)}), leaving them alone.`)
} else {
  console.log('No shrok containers running.')
}

if (fs.existsSync(workspacePath)) {
  fs.rmSync(workspacePath, { recursive: true, force: true })
  console.log(`Deleted ${workspacePath}`)
} else {
  console.log(`${workspacePath} does not exist, nothing to delete.`)
}

console.log(`\nEnvironment '${id}' removed.`)
if (wipeVolumes) console.log('Docker volumes also deleted.')
else console.log('Tip: pass --volumes to also delete Qdrant/FalkorDB data for this environment.')
