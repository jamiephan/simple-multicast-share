import { ChevronRight, Folder, Home } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { joinPath } from '../path'
import type { FileEntry } from '../types'
import { Modal } from './Modal'

interface MoveDialogProps {
  entry: FileEntry
  onClose: () => void
  onMove: (destination: string) => Promise<void>
}

export function MoveDialog({ entry, onClose, onMove }: MoveDialogProps) {
  const [path, setPath] = useState('')
  const [folders, setFolders] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [moving, setMoving] = useState(false)
  const [error, setError] = useState('')
  const crumbs = useMemo(() => path.split('/').filter(Boolean), [path])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    api.list(path, controller.signal)
      .then((listing) => setFolders(listing.entries.filter((item) =>
        item.kind === 'directory'
        && item.path !== entry.path
        && !item.path.startsWith(`${entry.path}/`),
      )))
      .catch((caught: unknown) => {
        if (!(caught instanceof DOMException && caught.name === 'AbortError')) {
          setError(caught instanceof Error ? caught.message : 'Could not load folders')
        }
      })
      .finally(() => setLoading(false))
    return () => controller.abort()
  }, [entry.path, path])

  const move = async () => {
    setMoving(true)
    setError('')
    try {
      await onMove(joinPath(path, entry.name))
      onClose()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not move item')
    } finally {
      setMoving(false)
    }
  }

  return (
    <Modal title={`Move “${entry.name}”`} onClose={onClose} footer={
      <>
        <button className="button secondary" onClick={onClose}>Cancel</button>
        <button className="button primary" disabled={moving || entry.path === joinPath(path, entry.name)} onClick={() => void move()}>
          {moving ? 'Moving…' : `Move to ${path || 'Files'}`}
        </button>
      </>
    }>
      <p className="hint">Choose a destination folder. Use the breadcrumbs to move the item back out to a parent or the root.</p>
      <nav className="breadcrumbs move-breadcrumbs" aria-label="Destination folder">
        <button onClick={() => setPath('')}><Home size={17} /><span>Files</span></button>
        {crumbs.map((part, index) => (
          <span className="crumb" key={`${part}-${index}`}>
            <ChevronRight size={16} />
            <button onClick={() => setPath(crumbs.slice(0, index + 1).join('/'))}>{part}</button>
          </span>
        ))}
      </nav>
      <div className="folder-picker">
        {loading ? <div className="empty-state compact"><div className="spinner" />Loading folders…</div> :
          error ? <div className="alert error" role="alert">{error}</div> :
          folders.length === 0 ? <div className="empty-state compact">No folders inside this location.</div> :
          folders.map((folder) => (
            <button key={folder.id} onClick={() => setPath(folder.path)}>
              <Folder size={22} />
              <span>{folder.name}</span>
              <ChevronRight size={17} />
            </button>
          ))}
      </div>
    </Modal>
  )
}
