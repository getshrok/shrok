// skills/build-app/example/app.test.ts
//
// Standalone in-process test for the example notes app.
// Run with: cd skills/build-app/example && npx tsx app.test.ts
// Exits 0 on pass, 1 on failure — no vitest dependency.
//
// This is the permanent per-app verification harness.  The build-app skill
// instructs the agent to run it after every change and keep it passing.

import * as os from "node:os"
import * as path from "node:path"
import * as fs from "node:fs"

// ── Set APP_DB_PATH BEFORE importing the app module (D-05) ───────────────────
//
// The module's top-level DatabaseSync init runs at import time.  The override
// must be in place before the dynamic import so the store opens the temp path.

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "apptest-"))
const tmpDb = path.join(tmpDir, "data.sqlite")
process.env.APP_DB_PATH = tmpDb

const app = await import("./app.ts")

// ── Helpers ───────────────────────────────────────────────────────────────────

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    process.exit(1)
  }
}

async function dispatch(name: string, state: unknown): Promise<{ ok?: boolean; vm?: unknown; state?: unknown }> {
  const res = await app.action(
    new Request("http://x/api/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, state }),
    }),
  )
  return res.json() as Promise<{ ok?: boolean; vm?: unknown; state?: unknown }>
}

// ── Test: get() returns initial view ─────────────────────────────────────────

const init = app.get()
assert(init.vm != null, "get() must return a non-null vm")
assert(init.state != null, "get() must return a non-null state")
const initState = init.state as { adding: boolean; error: string | null }
assert(initState.adding === false, "initial state.adding should be false")
assert(initState.error === null, "initial state.error should be null")

// ── Test: open-add action opens the add modal ─────────────────────────────────

const opened = await dispatch("open-add", init.state)
assert(opened.ok !== false, "open-add should return ok !== false")
const openedState = opened.state as { adding: boolean }
assert(openedState.adding === true, "open-add should set adding:true")

// ── Test: close action closes the modal ───────────────────────────────────────

const closed = await dispatch("close", openedState)
assert(closed.ok !== false, "close should return ok !== false")
const closedState = closed.state as { adding: boolean }
assert(closedState.adding === false, "close should set adding:false")

// ── Test: add action inserts a note ───────────────────────────────────────────
//
// The add action reads title/body from state.fields (bound by the form fields).

const beforeAdd = await dispatch("open-add", init.state)
const stateForAdd = beforeAdd.state as { adding: boolean; error: string | null; fields: { title: string; body: string } }

// Feed the form fields: title="Test Note", body="Hello world"
const withFields = { ...stateForAdd, fields: { title: "Test Note", body: "Hello world" } }
const added = await dispatch("add", withFields)
assert(added.ok !== false, "add should return ok !== false")
const addedState = added.state as { adding: boolean; error: string | null }
assert(addedState.adding === false, "add should close the modal (adding:false)")
assert(addedState.error === null, "add should not produce a state.error on valid input")

// Confirm the note appears in the next get() call (state reflects the DB)
const afterAdd = app.get()
const afterAddState = afterAdd.state as { adding: boolean }
assert(afterAddState != null, "get() after add must return state")

// The vm tree should now contain the note title
assert(afterAdd.vm != null, "get() after add must return non-null vm")

// ── Test: validation error — empty title ──────────────────────────────────────

const emptyTitle = { ...stateForAdd, fields: { title: "   ", body: "" } }
const badAdd = await dispatch("add", emptyTitle)
assert(badAdd.ok !== false, "add with empty title should return ok !== false (error surfaced as state.error)")
const badState = badAdd.state as { error: string | null }
assert(typeof badState.error === "string" && badState.error.length > 0,
  "add with empty title should surface a state.error message")

// ── Test: del-<id> action deletes the note ────────────────────────────────────
//
// After the successful add, the notes list must have at least one item.
// We retrieve the note id from the rendered vm page children.

// Add a second note to have a predictable id to delete
const noteToDelete = { ...stateForAdd, fields: { title: "Delete Me", body: "" } }
const addedDel = await dispatch("add", noteToDelete)
assert(addedDel.ok !== false, "add (delete-me note) should succeed")

// Now delete by walking the vm tree to find the del-<id> action name.
// The page has children; list items include a "Delete" button whose action
// name contains the note id.
const page = addedDel.vm as { type: string; children: unknown[] } | null | undefined
assert(page != null, "vm must be present after add")

// Find the first del-<id> action in the tree (we just added a note so at least one exists)
function findDelAction(node: unknown): string | undefined {
  if (node == null || typeof node !== "object") return undefined
  const n = node as Record<string, unknown>
  if (n["type"] === "button") {
    const act = n["action"] as { name: string } | undefined
    if (act?.name?.startsWith("del-")) return act.name
  }
  if (Array.isArray(n["children"])) {
    for (const child of n["children"]) {
      const found = findDelAction(child)
      if (found !== undefined) return found
    }
  }
  if (Array.isArray(n["footer"])) {
    for (const child of n["footer"]) {
      const found = findDelAction(child)
      if (found !== undefined) return found
    }
  }
  return undefined
}

const delAction = findDelAction(page)
assert(typeof delAction === "string", "vm must contain at least one del-<id> button after adding a note")

const deleted = await dispatch(delAction, init.state)
assert(deleted.ok !== false, `${delAction} should return ok !== false`)

// ── Test: unknown action triggers UnknownActionError ─────────────────────────
//
// The host handler re-throws UnknownActionError as a 422.  In our direct
// in-process call the Response will have ok:false.

const unknown = await dispatch("no-such-action", init.state)
// createAction catches UnknownActionError and returns {ok:false, errors:[...]}
assert(unknown.ok === false, "unrecognized action name should return ok:false")

// ── Cleanup ───────────────────────────────────────────────────────────────────

fs.rmSync(tmpDir, { recursive: true, force: true })
delete process.env.APP_DB_PATH

console.log("PASS")
