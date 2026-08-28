import { useEffect, useMemo, useRef, useState } from 'react'
import { mediaKindOf } from '@shared/types'
import type { LibraryItem } from '@shared/types'
import { Button, EmptyState, ErrorState, Modal, Spinner, formatBytes, formatDuration, formatWhen } from './ui'

export function LibraryView({
  items,
  loading,
  error,
  onReload,
  onOpen,
  onDelete,
  onRename,
  notify,
  onNewCapture
}: {
  items: LibraryItem[]
  loading: boolean
  error: string | null
  onReload: () => void
  onOpen: (item: LibraryItem) => void
  onDelete: (item: LibraryItem) => Promise<void>
  onRename: (item: LibraryItem, name: string) => Promise<void>
  notify: (msg: string, tone?: 'ok' | 'err') => void
  onNewCapture: () => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<LibraryItem | null>(null)
  const [renaming, setRenaming] = useState<LibraryItem | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const gridRef = useRef<HTMLUListElement>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter((i) => i.name.toLowerCase().includes(q))
  }, [items, query])

  // Keep the selection valid as the filter changes.
  useEffect(() => {
    if (selected && !filtered.some((i) => i.id === selected)) setSelected(null)
  }, [filtered, selected])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement
      const typing = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        searchRef.current?.focus()
        return
      }
      if (typing) {
        if (e.key === 'Escape') (target as HTMLInputElement).blur()
        return
      }
      if (!selected) return
      const item = filtered.find((i) => i.id === selected)
      if (!item) return

      if (e.key === 'Enter') {
        e.preventDefault()
        onOpen(item)
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        setConfirmDelete(item)
      } else if (e.key === 'F2') {
        e.preventDefault()
        setRenaming(item)
        setRenameValue(item.name)
      } else if (['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) {
        e.preventDefault()
        const idx = filtered.findIndex((i) => i.id === selected)
        const next =
          e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? filtered.length - 1
              : Math.min(filtered.length - 1, Math.max(0, idx + (e.key === 'ArrowRight' ? 1 : -1)))
        setSelected(filtered[next]?.id ?? null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected, filtered, onOpen])

  /** Exports the stored file as-is; main does the copy, so nothing large crosses IPC. */
  const doExport = async (item: LibraryItem): Promise<void> => {
    const res = await window.api.exportOriginal(item.id)
    if (!res.ok) notify(res.error, 'err')
    else if (res.value) notify(`Exported to ${res.value}`)
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner label="Loading your library…" />
      </div>
    )
  }

  if (error) {
    return <ErrorState title="Couldn't load your library" detail={error} onRetry={onReload} />
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-6 py-4">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Library</h1>
          <p className="text-xs text-text-secondary">
            {items.length} {items.length === 1 ? 'capture' : 'captures'}
          </p>
        </div>
        <div className="flex-1" />
        <div className="relative">
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search captures (Ctrl+F)"
            aria-label="Search captures"
            className="h-9 w-64 rounded-lg bg-surface-2 pl-9 pr-3 text-sm text-text-primary placeholder:text-text-secondary ring-1 ring-border-strong focus:ring-accent outline-none"
          />
        </div>
        <Button variant="primary" onClick={onNewCapture}>
          New capture
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-6">
        {/* Two distinct empty states — nothing captured yet vs. nothing matching. */}
        {items.length === 0 ? (
          <EmptyState
            icon={
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <rect x="3" y="5" width="18" height="14" rx="2" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            }
            title="No captures yet"
            body="Take your first screenshot or recording and it'll appear here, ready to annotate and export."
            action={
              <Button variant="primary" onClick={onNewCapture}>
                Take a capture
              </Button>
            }
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
              </svg>
            }
            title="No matches"
            body={`Nothing in your library matches “${query}”.`}
            action={<Button onClick={() => setQuery('')}>Clear search</Button>}
          />
        ) : (
          <ul
            ref={gridRef}
            className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4"
            aria-label="Captures"
          >
            {filtered.map((item) => (
              <li key={item.id}>
                {/* The card itself is presentational: nesting buttons inside a
                    role="button" is invalid ARIA and garbles the accessible name.
                    The preview is the real control and the card's tab stop. */}
                <div
                  className={`surface group flex flex-col overflow-hidden rounded-xl transition-all motion-panel ${
                    selected === item.id
                      ? 'border-accent ring-2 ring-accent/40'
                      : 'hover:border-accent'
                  }`}
                >
                  <button
                    type="button"
                    aria-label={item.name}
                    aria-pressed={selected === item.id}
                    onClick={() => setSelected(item.id)}
                    onDoubleClick={() => onOpen(item)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        setSelected(item.id)
                        onOpen(item)
                      }
                    }}
                    className="flex cursor-pointer flex-col text-left"
                  >
                  <div className="relative aspect-video bg-surface-0">
                    {mediaKindOf(item.kind) === 'video' ? (
                      <div className="flex h-full items-center justify-center text-text-secondary">
                        <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                          <circle cx="12" cy="12" r="9" />
                          <path d="m10 8 6 4-6 4V8Z" fill="currentColor" />
                        </svg>
                      </div>
                    ) : (
                      <img
                        src={`capture://asset/${item.id}`}
                        alt={item.name}
                        loading="lazy"
                        className="h-full w-full object-contain"
                      />
                    )}
                    <span className="absolute right-2 top-2 rounded bg-scrim/80 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-text-secondary">
                      {mediaKindOf(item.kind) === 'video'
                        ? item.durationMs
                          ? formatDuration(item.durationMs)
                          : 'video'
                        : item.captureKind}
                    </span>
                  </div>

                  <div className="flex min-w-0 flex-col gap-0.5 px-3 py-2.5">
                    <p className="truncate text-sm font-medium text-text-primary" title={item.name}>
                      {item.name}
                    </p>
                    <p className="font-mono text-[11px] text-text-secondary">
                      {item.width}×{item.height} · {formatBytes(item.size)} · {formatWhen(item.createdAt)}
                    </p>
                  </div>
                  </button>

                  <div className="flex items-center gap-1 border-t border-border px-2 py-1.5 opacity-0 transition-opacity motion-tool group-hover:opacity-100 focus-within:opacity-100">
                    <Button variant="subtle" onClick={() => onOpen(item)} title="Open in editor">
                      Open
                    </Button>
                    <Button variant="subtle" onClick={() => void doExport(item)} title="Export a copy">
                      Export
                    </Button>
                    <Button
                      variant="subtle"
                      onClick={() => {
                        setRenaming(item)
                        setRenameValue(item.name)
                      }}
                      title="Rename (F2)"
                    >
                      Rename
                    </Button>
                    <div className="flex-1" />
                    <Button
                      variant="subtle"
                      onClick={() => setConfirmDelete(item)}
                      title="Delete"
                      className="text-danger hover:bg-danger-surface"
                    >
                      Delete
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {confirmDelete && (
        <Modal
          title="Delete this capture?"
          onClose={() => setConfirmDelete(null)}
          footer={
            <>
              <Button autoFocusInModal onClick={() => setConfirmDelete(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  const target = confirmDelete
                  setConfirmDelete(null)
                  void onDelete(target)
                }}
              >
                Delete
              </Button>
            </>
          }
        >
          <strong className="text-text-primary">{confirmDelete.name}</strong> will be permanently removed
          from your library and deleted from disk. This can&apos;t be undone.
        </Modal>
      )}

      {renaming && (
        <Modal
          title="Rename capture"
          onClose={() => setRenaming(null)}
          footer={
            <>
              <Button onClick={() => setRenaming(null)}>Cancel</Button>
              <Button
                variant="primary"
                onClick={() => {
                  const target = renaming
                  const value = renameValue
                  setRenaming(null)
                  void onRename(target, value)
                }}
              >
                Rename
              </Button>
            </>
          }
        >
          <input
            data-autofocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const target = renaming
                const value = renameValue
                setRenaming(null)
                void onRename(target, value)
              }
            }}
            aria-label="Capture name"
            className="h-10 w-full rounded-lg bg-surface-2 px-3 text-sm text-text-primary ring-1 ring-border-strong focus:ring-accent outline-none"
          />
        </Modal>
      )}
    </div>
  )
}
