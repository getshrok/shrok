// skills/build-app/example/app.ts
//
// Golden example VMS app — a simple Notes CRUD.
// Copy this into apps/<slug>/ and adapt to your domain.
//
// Patterns in use:
//   D-05  APP_DB_PATH env override so tests can redirect to a temp sqlite.
//   D-11  journal_mode=DELETE (NOT WAL): data.sqlite is the single authoritative
//         file at rest, so workspace auto-commit captures a consistent snapshot.
//   D-06  Per-row identity encoded in payload.name ("del-<id>"), never a separate
//         context param.
//   D-07  createAction<State> wraps the entire handler; UnknownActionError is
//         re-thrown; other errors surface as state.error (in-page display).
//
// Verification: cd skills/build-app/example && npx tsx app.test.ts

import { createAction, UnknownActionError, type ShellResponseBody, type ViewNode } from "@ashley-shrok/viewmodel-shell/server"
import { DatabaseSync } from "node:sqlite"

// ── Store ─────────────────────────────────────────────────────────────────────
//
// DB is co-located next to app.ts.  APP_DB_PATH overrides the path so tests can
// point at a throwaway temp file set BEFORE this module is imported (D-05).
// journal_mode=DELETE (NOT WAL): a single data.sqlite with no -wal/-shm sidecars
// is always consistent for git commits (D-11).

const dbPath = process.env.APP_DB_PATH ?? new URL("./data.sqlite", import.meta.url).pathname
const db = new DatabaseSync(dbPath)
db.exec("PRAGMA journal_mode=DELETE") // NOT WAL — keeps data.sqlite as the single file (D-11)
db.exec("PRAGMA foreign_keys=ON")
db.exec(`CREATE TABLE IF NOT EXISTS notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT    NOT NULL,
  body       TEXT,
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL
)`)

// ── DB helpers ────────────────────────────────────────────────────────────────

type Note = { id: number; title: string; body: string | null; created_at: string; updated_at: string }

const stmtAll = db.prepare("SELECT * FROM notes ORDER BY updated_at DESC, id DESC")
const stmtAdd = db.prepare("INSERT INTO notes (title, body, created_at, updated_at) VALUES (?, ?, ?, ?)")
const stmtDel = db.prepare("DELETE FROM notes WHERE id = ?")

function allNotes(): Note[] { return stmtAll.all() as Note[] }

function addNote(title: string, body: string | null): void {
  const now = new Date().toISOString()
  stmtAdd.run(title, body, now, now)
}

function delNote(id: number): void {
  stmtDel.run(id)
}

// ── State ─────────────────────────────────────────────────────────────────────

type Fields = { title: string; body: string }
type State = { adding: boolean; error: string | null; fields: Fields }

function emptyFields(): Fields { return { title: "", body: "" } }
function empty(): State { return { adding: false, error: null, fields: emptyFields() } }

// ── Views ─────────────────────────────────────────────────────────────────────
//
// buildVm returns a minimal ViewNode tree.  The full ViewNode catalog is at
// /apps/_skill.md (served by the host, D-04) — refer there for all node types.

function buildVm(s: State): ViewNode {
  const notes = allNotes()
  const children: ViewNode[] = []

  // Primary action button
  children.push({ type: "button", label: "Add Note", action: { name: "open-add" }, variant: "primary" })

  // Inline validation error (surfaced by the action handler)
  if (s.error !== null) {
    children.push({ type: "text", value: s.error, style: "error" })
  }

  // Add-note modal — visible only while s.adding is true.
  // "Cancel" is the only close affordance (no dismissAction) to keep action
  // names unique in the tree (validateActionNames requirement).
  if (s.adding) {
    children.push({
      type: "modal",
      title: "New Note",
      children: [
        { type: "field", name: "title",  inputType: "text",     bind: "fields.title", label: "Title", placeholder: "Note title", required: true },
        { type: "field", name: "body",   inputType: "textarea", bind: "fields.body",  label: "Body",  placeholder: "Note body (optional)" },
      ],
      footer: [
        { type: "button", label: "Save",   action: { name: "add" },   variant: "primary" },
        { type: "button", label: "Cancel", action: { name: "close" } },
      ],
    })
  }

  // Notes list
  if (notes.length === 0) {
    children.push({ type: "text", value: "No notes yet. Click Add Note to create one.", style: "muted" })
  } else {
    const items: ViewNode[] = notes.map((n) => {
      const itemChildren: ViewNode[] = [
        { type: "text", value: n.title, style: "heading" },
      ]
      if (n.body !== null) {
        itemChildren.push({ type: "text", value: n.body })
      }
      itemChildren.push({ type: "button", label: "Delete", action: { name: `del-${n.id}` }, variant: "danger" })
      return { type: "list-item", children: itemChildren }
    })
    children.push({ type: "list", children: items })
  }

  return { type: "page", title: "Notes", children }
}

// ── Controller ────────────────────────────────────────────────────────────────

function render(s: State): ShellResponseBody<State> { return { vm: buildVm(s), state: s } }

// AppMod contract: meta + get + action (meta is optional per the type but exported
// here so the skill guidance can show all three members).
export const meta = { title: "Notes", icon: "📝", desc: "Quick notes — title and body." }

export function get(): ShellResponseBody<State> { return render(empty()) }

// createAction<State> wraps the full request lifecycle: parses {name, state} from
// the JSON body, calls this handler, returns a {ok, vm, state} Response.
export const action = createAction<State>(async (payload) => {
  let s: State = payload.state ?? empty()
  s = { ...s, error: null }

  try {
    // Per-row actions: identity is encoded in the action name (D-06).
    // e.g. "del-42" → delete note with id 42.
    if (payload.name.startsWith("del-")) {
      const id = Number(payload.name.slice(4))
      delNote(id)
      return render(empty())
    }

    switch (payload.name) {
      case "open-add":
        return render({ ...s, adding: true, fields: emptyFields() })

      case "close":
        return render({ ...s, adding: false })

      case "add": {
        const title = s.fields.title.trim()
        if (!title) throw new Error("Title is required.")
        const body = s.fields.body.trim()
        addNote(title, body !== "" ? body : null)
        return render(empty())
      }

      default:
        throw new UnknownActionError(payload.name)
    }
  } catch (e) {
    // Re-throw protocol errors so the host can return a proper 422.
    if (e instanceof UnknownActionError) throw e
    // Convert any other error to an in-page message (state.error → TextNode style:"error").
    return render({ ...s, error: (e as Error).message ?? String(e) })
  }
})
