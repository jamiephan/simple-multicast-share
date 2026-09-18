import {
  AlertTriangle, ArrowDown, ArrowUp, ArrowUpDown, Bug, ChevronDown, ChevronRight, CirclePlus, Download, FilePenLine, FilePlus2,
  Folder, FolderInput, FolderPlus, Grid2X2, HardDriveUpload, Home, List, Moon, MoreVertical,
  Move, Pencil, RefreshCw, Search, Sun, Trash2, Upload, X,
} from 'lucide-react'
import { type ChangeEvent, type DragEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, api, uploadFile } from './api'
import { ConfirmDialog, Modal, PromptDialog } from './components/Modal'
import { DatabaseInspector } from './components/DatabaseInspector'
import { FileTypeIcon } from './components/FileTypeIcon'
import { MoveDialog } from './components/MoveDialog'
import { Preview } from './components/Preview'
import { fileTypeLabel, sortFileEntries, type SortDirection, type SortField } from './file-list'
import { formatBytes, joinPath, parentPath } from './path'
import type { FileEntry, Theme, UploadProgress, ViewMode } from './types'

type PromptState =
  | { type: 'folder' }
  | { type: 'file' }
  | { type: 'rename'; entry: FileEntry }
  | { type: 'save-as'; suggested: string; run: (name: string) => Promise<void> }
  | null

function displayDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? 'Unknown' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

export default function App() {
  const [path, setPath] = useState(() => new URLSearchParams(location.search).get('path') ?? '')
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [query, setQuery] = useState('')
  const [view, setView] = useState<ViewMode>(() => localStorage.getItem('view') === 'list' ? 'list' : 'grid')
  const [sortField, setSortField] = useState<SortField>('name')
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc')
  const [theme, setTheme] = useState<Theme>('system')
  const [prompt, setPrompt] = useState<PromptState>(null)
  const [deleting, setDeleting] = useState<FileEntry | null>(null)
  const [moving, setMoving] = useState<FileEntry | null>(null)
  const [debugging, setDebugging] = useState(false)
  const [preview, setPreview] = useState<FileEntry | null>(null)
  const [menu, setMenu] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [uploads, setUploads] = useState<UploadProgress[]>([])
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState<{ name: string; overwrite: () => Promise<void>; saveAs: () => void } | null>(null)
  const uploadInput = useRef<HTMLInputElement>(null)
  const replaceInput = useRef<HTMLInputElement>(null)
  const replacing = useRef<FileEntry | null>(null)
  const uploadSequence = useRef(0)
  const dragDepth = useRef(0)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    const controller = new AbortController()
    try {
      const result = await api.list(path, controller.signal)
      setEntries(result.entries)
    } catch (caught) {
      if (!(caught instanceof DOMException && caught.name === 'AbortError')) {
        setError(caught instanceof Error ? caught.message : 'Could not load this folder')
      }
    } finally {
      setLoading(false)
    }
    return () => controller.abort()
  }, [path])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    const params = new URLSearchParams(location.search)
    if (path) params.set('path', path)
    else params.delete('path')
    history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}`)
  }, [path])
  useEffect(() => {
    api.preferences().then((saved) => {
      if (saved.theme === 'light' || saved.theme === 'dark' || saved.theme === 'system') {
        setTheme(saved.theme)
      }
      if (saved.view === 'grid' || saved.view === 'list') {
        setView(saved.view)
      }
      if (
        typeof saved.sort === 'object'
        && saved.sort !== null
        && 'field' in saved.sort
        && 'direction' in saved.sort
      ) {
        const sort = saved.sort as { field?: unknown; direction?: unknown }
        if (sort.field === 'name' || sort.field === 'type' || sort.field === 'size' || sort.field === 'modified') {
          setSortField(sort.field)
        }
        if (sort.direction === 'asc' || sort.direction === 'desc') {
          setSortDirection(sort.direction)
        }
      }
    }).catch(() => {
      const saved = localStorage.getItem('theme') as Theme | null
      if (saved) setTheme(saved)
    })
  }, [])
  useEffect(() => {
    const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#111318' : '#f7f8fa')
    localStorage.setItem('theme', theme)
  }, [theme])
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 3500)
    return () => clearTimeout(timer)
  }, [notice])

  const setMode = (mode: ViewMode) => {
    setView(mode)
    localStorage.setItem('view', mode)
    void api.saveView(mode).catch((caught) => {
      setError(`View changed locally, but the server preference was not saved: ${caught instanceof Error ? caught.message : 'Unknown error'}`)
    })
  }
  const changeTheme = async () => {
    const next: Theme = theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light'
    setTheme(next)
    try { await api.saveTheme(next) } catch (caught) {
      setError(`Theme changed locally, but the server preference was not saved: ${caught instanceof Error ? caught.message : 'Unknown error'}`)
    }
  }

  const changeSort = (field: SortField) => {
    const direction: SortDirection = field === sortField
      ? sortDirection === 'asc' ? 'desc' : 'asc'
      : 'asc'
    setSortField(field)
    setSortDirection(direction)
    void api.saveSort(field, direction).catch((caught) => {
      setError(`Sort changed locally, but the server preference was not saved: ${caught instanceof Error ? caught.message : 'Unknown error'}`)
    })
  }
  const setSort = (field: SortField, direction: SortDirection) => {
    setSortField(field)
    setSortDirection(direction)
    void api.saveSort(field, direction).catch((caught) => {
      setError(`Sort changed locally, but the server preference was not saved: ${caught instanceof Error ? caught.message : 'Unknown error'}`)
    })
  }
  const sorted = useMemo(() => sortFileEntries(
    entries.filter((entry) => entry.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())),
    sortField,
    sortDirection,
  ), [entries, query, sortDirection, sortField])
  const crumbs = useMemo(() => path.split('/').filter(Boolean), [path])
  const darkTheme = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)

  const runAction = async (action: () => Promise<void>, success: string) => {
    setBusy(true)
    setError('')
    try {
      await action()
      setNotice(success)
      await load()
      return true
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The operation failed')
      return false
    } finally {
      setBusy(false)
    }
  }

  const openEntry = (entry: FileEntry) => {
    setMenu(null)
    if (entry.kind === 'directory') {
      setPath(entry.path)
      setQuery('')
    } else setPreview(entry)
  }

  const submitPrompt = async (value: string) => {
    if (!prompt) return
    if (prompt.type === 'folder') {
      if (await runAction(() => api.createFolder(joinPath(path, value)), `Created folder “${value}”`)) setPrompt(null)
    } else if (prompt.type === 'file') {
      if (await runAction(() => api.createText(joinPath(path, value), ''), `Created “${value}”`)) {
        setPrompt(null)
      }
    } else if (prompt.type === 'rename') {
      if (await runAction(() => api.rename(prompt.entry.path, value), `Renamed to “${value}”`)) setPrompt(null)
    } else {
      setBusy(true)
      try {
        await prompt.run(value)
        setPrompt(null)
        setNotice(`Saved as “${value}”`)
        await load()
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Could not save file')
      } finally { setBusy(false) }
    }
  }

  const addUpload = async (file: File | Blob, name: string, overwrite = false, directory = path) => {
    uploadSequence.current += 1
    const id = `${Date.now()}-${uploadSequence.current}`
    setUploads((items) => [...items, { id, name, percent: 0, state: 'uploading' }])
    const transfer = uploadFile(directory, file, name, overwrite, (percent) =>
      setUploads((items) => items.map((item) => item.id === id ? { ...item, percent } : item)))
    try {
      await transfer.promise
      setUploads((items) => items.map((item) => item.id === id ? { ...item, percent: 100, state: 'done' } : item))
      setNotice(`Uploaded “${name}”`)
      await load()
    } catch (caught) {
      setUploads((items) => items.map((item) => item.id === id ? { ...item, state: 'error', error: caught instanceof Error ? caught.message : 'Upload failed' } : item))
      throw caught
    }
  }

  const uploadOne = async (file: File, forceName?: string, forceOverwrite = false) => {
    const name = forceName ?? file.name
    try {
      await addUpload(file, name, forceOverwrite)
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409 && !forceOverwrite) {
        setConflict({
          name,
          overwrite: async () => {
            setConflict(null)
            await addUpload(file, name, true)
          },
          saveAs: () => {
            setConflict(null)
            setPrompt({ type: 'save-as', suggested: `copy of ${name}`, run: (newName) => addUpload(file, newName) })
          },
        })
      } else setError(caught instanceof Error ? caught.message : 'Upload failed')
    }
  }

  const uploadFiles = (files: FileList | File[]) => {
    for (const file of Array.from(files)) void uploadOne(file)
  }

  const dragContainsFiles = (event: DragEvent) =>
    Array.from(event.dataTransfer.types).includes('Files')

  const replace = (entry: FileEntry) => {
    replacing.current = entry
    replaceInput.current?.click()
  }

  const saveEditedImage = async (blob: Blob, outputName: string) => {
    const original = preview
    if (!original) return
    await new Promise<void>((resolve, reject) => {
      setConflict({
        name: original.name,
        overwrite: async () => {
          setConflict(null)
          try {
            await addUpload(blob, original.name, true, parentPath(original.path))
            resolve()
          } catch (error) { reject(error) }
        },
        saveAs: () => {
          setConflict(null)
          setPrompt({
            type: 'save-as',
            suggested: outputName,
            run: async (newName) => {
              await addUpload(blob, newName, false, parentPath(original.path))
              resolve()
            },
          })
        },
      })
    })
  }

  const actionMenu = (entry: FileEntry) => (
    <div className="entry-actions">
      <button className="icon-button" aria-label={`Actions for ${entry.name}`} aria-expanded={menu === entry.path} onClick={(event) => {
        event.stopPropagation()
        setMenu(menu === entry.path ? null : entry.path)
      }}><MoreVertical size={18} /></button>
      {menu === entry.path && <div className="context-menu" role="menu" onClick={(event) => event.stopPropagation()}>
        {entry.kind === 'file' && <>
          <button role="menuitem" onClick={() => openEntry(entry)}><FilePenLine size={16} />Preview / edit</button>
          <a role="menuitem" href={api.downloadUrl(entry.id)} download onClick={() => setMenu(null)}><Download size={16} />Download</a>
          <button role="menuitem" onClick={() => replace(entry)}><HardDriveUpload size={16} />Replace contents</button>
        </>}
        <button role="menuitem" onClick={() => { setPrompt({ type: 'rename', entry }); setMenu(null) }}><Pencil size={16} />Rename</button>
        <button role="menuitem" onClick={() => { setMoving(entry); setMenu(null) }}><Move size={16} />Move to folder…</button>
        <button className="menu-danger" role="menuitem" onClick={() => { setDeleting(entry); setMenu(null) }}><Trash2 size={16} />Delete</button>
      </div>}
    </div>
  )

  return (
    <div
      className="app"
      onClick={() => menu && setMenu(null)}
      onDragEnter={(event) => {
        if (!dragContainsFiles(event)) return
        event.preventDefault()
        dragDepth.current += 1
        setDragging(true)
      }}
      onDragOver={(event) => {
        if (dragContainsFiles(event)) event.preventDefault()
      }}
      onDragLeave={(event) => {
        if (!dragContainsFiles(event)) return
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDragging(false)
      }}
      onDrop={(event: DragEvent) => {
        if (!dragContainsFiles(event)) return
        event.preventDefault()
        dragDepth.current = 0
        setDragging(false)
        uploadFiles(event.dataTransfer.files)
      }}
    >
      {dragging && <div className="drop-overlay"><Upload size={48} /><strong>Drop files to upload</strong><span>Files will be uploaded into {path || 'the root folder'}</span></div>}
      <header className="topbar">
        <div className="brand"><div className="brand-mark"><FolderInput /></div><div><strong>Simple Share</strong><span>Files available on this device</span></div></div>
        <div className="top-actions">
          <button className="icon-button" title="Inspect SQLite database" aria-label="Open database inspector" onClick={() => setDebugging(true)}>
            <Bug size={19} />
          </button>
          <button className="icon-button theme-button" title={`Theme: ${theme}`} aria-label={`Change theme. Current theme: ${theme}`} onClick={changeTheme}>
            {theme === 'dark' ? <Moon size={19} /> : <Sun size={19} />}
          </button>
        </div>
      </header>

      <main>
        <nav className="breadcrumbs" aria-label="Breadcrumb">
          <button onClick={() => setPath('')} aria-label="Root folder"><Home size={17} /><span>Files</span></button>
          {crumbs.map((part, index) => <span className="crumb" key={`${part}-${index}`}><ChevronRight size={16} /><button onClick={() => setPath(crumbs.slice(0, index + 1).join('/'))}>{part}</button></span>)}
        </nav>

        <section className="commandbar" aria-label="File controls">
          <div className="create-group">
            <button className="button primary" onClick={() => uploadInput.current?.click()}><Upload size={17} />Upload</button>
            <button className="button secondary" onClick={() => setPrompt({ type: 'folder' })}><FolderPlus size={17} />New folder</button>
            <button className="button secondary" onClick={() => setPrompt({ type: 'file' })}><FilePlus2 size={17} />New text file</button>
          </div>
          <div className="view-group">
            <label className="search"><Search size={17} /><span className="sr-only">Filter files</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter files…" />{query && <button aria-label="Clear filter" onClick={() => setQuery('')}><X size={15} /></button>}</label>
            {view === 'grid' && <>
              <label className="sort-select">
                <span className="sr-only">Sort files by</span>
                <ArrowUpDown size={16} />
                <select value={sortField} onChange={(event) => setSort(event.target.value as SortField, 'asc')}>
                  <option value="name">Name</option>
                  <option value="type">Type</option>
                  <option value="size">Size</option>
                  <option value="modified">Modified</option>
                </select>
                <ChevronDown className="sort-select-chevron" size={14} aria-hidden="true" />
              </label>
              <button className="icon-button sort-direction" title={`Sort ${sortDirection === 'asc' ? 'ascending' : 'descending'}`} aria-label={`Sort ${sortDirection === 'asc' ? 'descending' : 'ascending'}`} onClick={() => setSort(sortField, sortDirection === 'asc' ? 'desc' : 'asc')}>
                {sortDirection === 'asc' ? <ArrowUp size={17} /> : <ArrowDown size={17} />}
              </button>
            </>}
            <button className="icon-button" aria-label="Refresh folder" onClick={() => void load()}><RefreshCw size={18} /></button>
            <div className="segmented" aria-label="View mode">
              <button aria-label="Grid view" aria-pressed={view === 'grid'} onClick={() => setMode('grid')}><Grid2X2 size={17} /></button>
              <button aria-label="List view" aria-pressed={view === 'list'} onClick={() => setMode('list')}><List size={18} /></button>
            </div>
          </div>
        </section>

        {error && <div className="alert error" role="alert"><AlertTriangle size={18} /><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}><X size={17} /></button></div>}
        {notice && <div className="toast" role="status">{notice}</div>}

        <section className="drop-zone">
          {loading ? <div className="empty-state"><div className="spinner" />Loading files…</div> :
            sorted.length === 0 ? <div className="empty-state">
              <Folder size={48} />
              <h2>{query ? 'No matching files' : 'This folder is empty'}</h2>
              <p>{query ? 'Try a different filter.' : 'Drag files here, upload them, or create a folder.'}</p>
              {!query && <button className="button primary" onClick={() => uploadInput.current?.click()}><CirclePlus size={17} />Add files</button>}
            </div> :
            view === 'grid' ? <div className="file-grid">
              {sorted.map((entry) => <article className="file-card" key={entry.path} tabIndex={0} onDoubleClick={() => openEntry(entry)} onKeyDown={(event) => {
                if (event.key === 'Enter') openEntry(entry)
              }}>
                {actionMenu(entry)}
                <button className="card-open" onClick={() => openEntry(entry)}>
                  <FileTypeIcon entry={entry} />
                  <span className="entry-name" title={entry.name}>{entry.name}</span>
                  <span className="entry-meta">{entry.kind === 'directory' ? 'Folder' : formatBytes(entry.size)}</span>
                </button>
              </article>)}
            </div> :
            <div className="file-table" role="table" aria-label="Files">
              <div className="table-head" role="row">
                {([
                  ['name', 'Name'],
                  ['type', 'Type'],
                  ['size', 'Size'],
                  ['modified', 'Modified'],
                ] as const).map(([field, label]) => (
                  <span role="columnheader" aria-sort={sortField === field ? sortDirection === 'asc' ? 'ascending' : 'descending' : 'none'} key={field}>
                    <button className={sortField === field ? 'active' : ''} onClick={() => changeSort(field)}>
                      {label}
                      {sortField === field ? sortDirection === 'asc' ? <ArrowUp size={14} /> : <ArrowDown size={14} /> : <ArrowUpDown size={13} />}
                    </button>
                  </span>
                ))}
                <span role="columnheader"><span className="sr-only">Actions</span></span>
              </div>
              {sorted.map((entry) => <div className="table-row" role="row" key={entry.path} onDoubleClick={() => openEntry(entry)}>
                <button role="cell" className="table-name" onClick={() => openEntry(entry)}><FileTypeIcon entry={entry} /><span title={entry.name}>{entry.name}</span></button>
                <span role="cell">{fileTypeLabel(entry)}</span>
                <span role="cell">{entry.kind === 'file' ? formatBytes(entry.size) : '—'}</span>
                <span role="cell">{displayDate(entry.modified)}</span>
                <span role="cell">{actionMenu(entry)}</span>
              </div>)}
            </div>}
        </section>
      </main>

      <input ref={uploadInput} className="sr-only" type="file" multiple onChange={(event: ChangeEvent<HTMLInputElement>) => {
        if (event.target.files) uploadFiles(event.target.files)
        event.target.value = ''
      }} />
      <input ref={replaceInput} className="sr-only" type="file" onChange={(event) => {
        const file = event.target.files?.[0]
        const target = replacing.current
        if (file && target) void uploadOne(file, target.name, true)
        replacing.current = null
        event.target.value = ''
      }} />

      {uploads.length > 0 && <aside className="uploads" aria-label="Upload progress">
        <header><strong>Transfers</strong><button className="icon-button" aria-label="Clear completed transfers" onClick={() => setUploads((items) => items.filter((item) => item.state === 'uploading'))}><X size={16} /></button></header>
        {uploads.map((item) => <div className={`upload-row ${item.state}`} key={item.id}>
          <div><span title={item.name}>{item.name}</span><small>{item.state === 'uploading' ? `${item.percent}%` : item.state === 'done' ? 'Complete' : item.error}</small></div>
          <progress value={item.percent} max="100" aria-label={`Upload progress for ${item.name}`} />
        </div>)}
      </aside>}

      {prompt && <PromptDialog
        title={prompt.type === 'folder' ? 'Create folder' : prompt.type === 'file' ? 'Create text file' : prompt.type === 'rename' ? 'Rename item' : 'Save as new'}
        label={prompt.type === 'folder' ? 'Folder name' : 'File name'}
        value={prompt.type === 'folder' ? 'New folder' : prompt.type === 'file' ? 'untitled.txt' : prompt.type === 'rename' ? prompt.entry.name : prompt.suggested}
        confirmLabel={prompt.type === 'rename' ? 'Rename' : 'Create'}
        onConfirm={(value) => void submitPrompt(value)}
        onClose={() => setPrompt(null)}
      />}
      {moving && <MoveDialog
        entry={moving}
        onClose={() => setMoving(null)}
        onMove={async (destination) => {
          const target = moving
          if (!target) return
          const moved = await runAction(() => api.move(target.path, destination), `Moved “${target.name}”`)
          if (!moved) throw new Error('The move could not be completed')
        }}
      />}
      {deleting && <ConfirmDialog title={`Delete ${deleting.kind === 'directory' ? 'folder' : 'file'}?`} confirmLabel="Delete permanently" danger onClose={() => setDeleting(null)} onConfirm={() => {
        const target = deleting
        setDeleting(null)
        void runAction(() => api.remove(target.path), `Deleted “${target.name}”`)
      }}>
        <p>“{deleting.name}” will be permanently deleted.{deleting.kind === 'directory' && ' This includes every file and subfolder inside it.'}</p>
        <p className="danger-text">This action cannot be undone.</p>
      </ConfirmDialog>}
      {conflict && <Modal title="File already exists" onClose={() => setConflict(null)} footer={
        <>
          <button className="button secondary" onClick={() => setConflict(null)}>Cancel</button>
          <button className="button secondary" onClick={conflict.saveAs}>Save as new</button>
          <button className="button danger" onClick={() => void conflict.overwrite()}>Replace</button>
        </>
      }><p>“{conflict.name}” already exists in this folder. Replace it, or keep both files by choosing a new name.</p></Modal>}
      {preview && <Preview entry={preview} dark={darkTheme} onClose={() => setPreview(null)} onChanged={() => void load()} onSaveImage={saveEditedImage} />}
      {debugging && <DatabaseInspector onClose={() => setDebugging(false)} onChanged={() => void load()} />}
      {busy && <div className="busy" role="status"><div className="spinner" />Working…</div>}
    </div>
  )
}
