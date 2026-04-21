import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ChevronRight } from 'lucide-react'
import { api } from '../lib/api'

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Resolve a relative .md link `href` against the current file's directory,
 * collapsing `.` and `..` segments. Stripped of any `#fragment`.
 * If `href` is a pure anchor (no path part), returns `base` unchanged.
 */
function resolveRelative(base: string, href: string): string {
  const hashIdx = href.indexOf('#')
  const pathPart = hashIdx >= 0 ? href.slice(0, hashIdx) : href
  if (!pathPart) return base
  const baseDir = base.includes('/') ? base.slice(0, base.lastIndexOf('/')) : ''
  const parts = (baseDir ? baseDir.split('/') : []).concat(pathPart.split('/'))
  const stack: string[] = []
  for (const p of parts) {
    if (!p || p === '.') continue
    if (p === '..') stack.pop()
    else stack.push(p)
  }
  return stack.join('/')
}

function isExternal(href: string): boolean {
  return /^(https?:|mailto:)/i.test(href)
}

const MD_PROSE_CLASSES = [
  'max-w-3xl',
  '[&_h1]:text-2xl [&_h1]:font-semibold [&_h1]:text-zinc-100 [&_h1]:mt-0 [&_h1]:mb-4',
  '[&_h2]:text-xl [&_h2]:font-semibold [&_h2]:text-zinc-100 [&_h2]:mt-6 [&_h2]:mb-3',
  '[&_h3]:text-lg [&_h3]:font-semibold [&_h3]:text-zinc-100 [&_h3]:mt-5 [&_h3]:mb-2',
  '[&_p]:text-zinc-300 [&_p]:my-3 [&_p]:leading-relaxed',
  '[&_code]:text-[var(--accent)] [&_code]:text-[0.9em]',
  '[&_pre]:bg-zinc-950 [&_pre]:border [&_pre]:border-zinc-800 [&_pre]:p-3 [&_pre]:rounded [&_pre]:my-3 [&_pre]:overflow-x-auto',
  '[&_pre_code]:text-zinc-300',
  '[&_a]:text-[var(--accent)] [&_a:hover]:underline',
  '[&_ul]:list-disc [&_ul]:pl-5 [&_ul]:my-3 [&_ul]:text-zinc-300',
  '[&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:my-3 [&_ol]:text-zinc-300',
  '[&_li]:my-1',
  '[&_blockquote]:border-l-2 [&_blockquote]:border-zinc-700 [&_blockquote]:pl-3 [&_blockquote]:text-zinc-400 [&_blockquote]:my-3',
  '[&_table]:border-collapse [&_table]:my-3',
  '[&_th]:border [&_th]:border-zinc-800 [&_th]:px-2 [&_th]:py-1 [&_th]:text-zinc-200',
  '[&_td]:border [&_td]:border-zinc-800 [&_td]:px-2 [&_td]:py-1 [&_td]:text-zinc-300',
  '[&_hr]:border-zinc-800 [&_hr]:my-4',
  '[&_strong]:text-zinc-100',
].join(' ')

// ─── Page ───────────────────────────────────────────────────────────────────

// Groups collapsed by default — the Internals section is reference material
// most users won't need unless they ask for it. The group containing the
// currently-selected file auto-expands so deep links still land visibly.
const DEFAULT_COLLAPSED_GROUPS = new Set<string>(['Internals'])

export default function DocsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const currentPath = searchParams.get('file') ?? ''

  const tree = useQuery({
    queryKey: ['docs-list'],
    queryFn: () => api.docs.list(),
  })

  // Auto-navigate to first available doc when no file is selected
  useEffect(() => {
    if (currentPath || !tree.data) return
    const first = tree.data.root[0] ?? tree.data.groups[0]?.files[0]
    if (first) setSearchParams({ file: first.path }, { replace: true })
  }, [currentPath, tree.data, setSearchParams])

  // Track user-toggled group open/closed state. Starts from
  // DEFAULT_COLLAPSED_GROUPS; user toggles override. Active group always
  // expands regardless of user toggle so the current selection is visible.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(DEFAULT_COLLAPSED_GROUPS))
  const toggle = (groupName: string) => setCollapsed(prev => {
    const next = new Set(prev)
    if (next.has(groupName)) next.delete(groupName); else next.add(groupName)
    return next
  })

  const doc = useQuery({
    queryKey: ['docs-file', currentPath],
    queryFn: () => api.docs.file(currentPath),
    enabled: !!currentPath,
  })

  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [currentPath])

  const navigate = (p: string) => setSearchParams({ file: p })

  // Custom `a` renderer: in-app navigation for relative .md links, new-tab for external.
  const LinkRewriter = ({ href, children, ...rest }: {
    href?: string
    children?: React.ReactNode
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => {
    if (!href) return <a {...rest}>{children}</a>
    if (isExternal(href)) {
      return <a href={href} target="_blank" rel="noreferrer noopener" {...rest}>{children}</a>
    }
    if (href.startsWith('#')) {
      return <a href={href} {...rest}>{children}</a>
    }
    const resolved = resolveRelative(currentPath, href)
    if (resolved.endsWith('.md')) {
      return (
        <a
          href={`/docs?file=${encodeURIComponent(resolved)}`}
          onClick={e => {
            e.preventDefault()
            navigate(resolved)
          }}
          {...rest}
        >
          {children}
        </a>
      )
    }
    // Non-.md relative links — fall back to plain anchor (likely broken but don't hijack).
    return <a href={href} {...rest}>{children}</a>
  }

  const breadcrumb = currentPath.split('/').join(' / ')

  return (
    <div className="flex h-full">
      {/* Left pane: TOC */}
      <aside className="w-64 border-r border-zinc-800 bg-zinc-900/50 overflow-y-auto shrink-0">
        <div className="px-4 py-5 border-b border-zinc-800">
          <h2 className="text-sm font-semibold text-zinc-200">Docs</h2>
          <p className="text-xs text-zinc-500 mt-1">Read the shrok documentation</p>
        </div>

        {tree.isLoading && (
          <div className="px-4 py-3 text-xs text-zinc-500">Loading…</div>
        )}
        {tree.error && (
          <div className="px-4 py-3 text-xs text-red-400">
            {(tree.error as Error).message}
          </div>
        )}

        {tree.data && (
          <nav className="py-2">
            {/* Root files — concepts.md is the landing page */}
            <ul className="px-2 space-y-0.5">
              {tree.data.root.map(f => (
                <TocItem
                  key={f.path}
                  active={f.path === currentPath}
                  onClick={() => navigate(f.path)}
                  label={f.title}
                />
              ))}
            </ul>

            {tree.data.groups.map(g => {
              const containsActive = g.files.some(f => f.path === currentPath)
              const isOpen = !collapsed.has(g.name) || containsActive
              return (
                <div key={g.name} className="mt-4">
                  <button
                    onClick={() => toggle(g.name)}
                    className="w-full flex items-center gap-1 px-4 py-1 text-[10px] uppercase tracking-wider text-zinc-500 hover:text-zinc-300 font-semibold"
                  >
                    <ChevronRight
                      size={12}
                      className={`transition-transform ${isOpen ? 'rotate-90' : ''}`}
                    />
                    {g.name}
                  </button>
                  {isOpen && (
                    <ul className="px-2 space-y-0.5 mt-1">
                      {g.files.map(f => (
                        <TocItem
                          key={f.path}
                          active={f.path === currentPath}
                          onClick={() => navigate(f.path)}
                          label={f.title}
                        />
                      ))}
                    </ul>
                  )}
                </div>
              )
            })}
          </nav>
        )}
      </aside>

      {/* Right pane: markdown viewer */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="px-8 py-6">
          <div className="text-xs text-zinc-500 mb-4 font-mono">{breadcrumb}</div>

          {doc.isLoading && (
            <div className="text-sm text-zinc-500">Loading…</div>
          )}
          {doc.error && (
            <div className="text-sm text-red-400">
              {(doc.error as Error).message}
            </div>
          )}
          {doc.data && (
            <article className={MD_PROSE_CLASSES}>
              <Markdown
                remarkPlugins={[remarkGfm]}
                components={{ a: LinkRewriter }}
              >
                {doc.data.content}
              </Markdown>
            </article>
          )}
        </div>
      </div>
    </div>
  )
}

function TocItem({ active, onClick, label }: {
  active: boolean
  onClick: () => void
  label: string
}) {
  return (
    <li>
      <button
        onClick={onClick}
        className={`w-full text-left px-3 py-1.5 rounded text-sm transition-colors border-l-2 ${
          active
            ? 'bg-[var(--accent)]/10 text-zinc-100 border-[var(--accent)]'
            : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 border-transparent'
        }`}
      >
        {label}
      </button>
    </li>
  )
}
