import type { DirectoryListing, FileEntry, Theme, ViewMode } from './types'

export class ApiError extends Error {
  status: number
  code?: string

  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

export type DebugValue =
  | { type: 'null' }
  | { type: 'integer'; value: number }
  | { type: 'real'; value: number }
  | { type: 'text'; value: string }
  | { type: 'blob'; size: number; base64?: string }

export interface DebugDatabaseInfo {
  stats: DebugDatabaseStats
  tables: {
    name: string
    columns: { name: string; data_type: string; nullable: boolean; primary_key: boolean }[]
  }[]
}

export interface DebugDatabaseStats {
  database_bytes: number
  wal_bytes: number
  total_disk_bytes: number
  page_size: number
  page_count: number
  free_pages: number
  reclaimable_bytes: number
}

export interface DebugCompactResult {
  before: DebugDatabaseStats
  after: DebugDatabaseStats
  reclaimed_bytes: number
}

export interface DebugTableRows {
  table: string
  columns: string[]
  rows: { rowid: number; cells: DebugValue[] }[]
  total: number
  limit: number
  offset: number
}

interface BackendItem {
  id: number
  parent_id: number | null
  name: string
  kind: 'file' | 'folder'
  mime?: string
  size: number
  revision: number
  created_at: string
  updated_at: string
}

async function parseError(response: Response): Promise<ApiError> {
  let detail: { message?: string; error?: string; code?: string } = {}
  try {
    detail = await response.json() as typeof detail
  } catch {
    detail.message = await response.text().catch(() => '')
  }
  return new ApiError(
    detail.message || detail.error || `Request failed (${response.status})`,
    response.status,
    detail.code,
  )
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  if (!response.ok) throw await parseError(response)
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

const parts = (path: string) => path.split('/').filter(Boolean)
const baseName = (path: string) => parts(path).at(-1) ?? ''
const parentPath = (path: string) => parts(path).slice(0, -1).join('/')

async function children(parentId: number, signal?: AbortSignal) {
  return request<BackendItem[]>(`/api/items?parent_id=${parentId}`, { signal })
}

async function resolvePath(path: string, signal?: AbortSignal): Promise<BackendItem> {
  let current: BackendItem = {
    id: 1,
    parent_id: null,
    name: '',
    kind: 'folder',
    size: 0,
    revision: 1,
    created_at: '',
    updated_at: '',
  }
  for (const component of parts(path)) {
    const match = (await children(current.id, signal)).find((item) => item.name === component)
    if (!match) throw new ApiError(`“${path}” does not exist`, 404)
    current = match
  }
  return current
}

async function optionalPath(path: string): Promise<BackendItem | undefined> {
  try {
    return await resolvePath(path)
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return undefined
    throw error
  }
}

function toEntry(item: BackendItem, parent: string): FileEntry {
  return {
    id: item.id,
    parentId: item.parent_id,
    revision: item.revision,
    name: item.name,
    path: [...parts(parent), item.name].join('/'),
    kind: item.kind === 'folder' ? 'directory' : 'file',
    size: item.kind === 'folder' ? null : item.size,
    modified: item.updated_at,
    mime: item.mime,
  }
}

async function updateItem(id: number, changes: { name?: string; parent_id?: number }) {
  return request<BackendItem>(`/api/items/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(changes),
  })
}

const textRevisions = new Map<string, number>()

export const api = {
  list: async (path: string, signal?: AbortSignal): Promise<DirectoryListing> => {
    const folder = await resolvePath(path, signal)
    if (folder.kind !== 'folder') throw new ApiError(`“${path}” is not a folder`, 400)
    const entries = await children(folder.id, signal)
    return { path, entries: entries.map((item) => toEntry(item, path)) }
  },
  createFolder: async (path: string) => {
    const parent = await resolvePath(parentPath(path))
    await request<BackendItem>('/api/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent_id: parent.id, name: baseName(path) }),
    })
  },
  createText: async (path: string, content: string, overwrite = false) => {
    const existing = await optionalPath(path)
    if (existing) {
      if (!overwrite) throw new ApiError('An item with that name already exists', 409)
      await request<BackendItem>(`/api/files/${existing.id}/content?expected_revision=${existing.revision}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        body: content,
      })
      return
    }
    const parent = await resolvePath(parentPath(path))
    await request<BackendItem>(
      `/api/files?${new URLSearchParams({ parent_id: String(parent.id), name: baseName(path) })}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        body: content,
      },
    )
  },
  saveText: async (path: string, content: string) => {
    const item = await resolvePath(path)
    const revision = textRevisions.get(path) ?? item.revision
    const updated = await request<BackendItem>(`/api/files/${item.id}/text`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, expected_revision: revision }),
    })
    textRevisions.set(path, updated.revision)
  },
  readText: async (path: string, signal?: AbortSignal) => {
    const item = await resolvePath(path, signal)
    const value = await request<{ content: string; revision: number }>(`/api/files/${item.id}/text`, { signal })
    textRevisions.set(path, value.revision)
    return value.content
  },
  rename: async (path: string, name: string) => {
    const item = await resolvePath(path)
    await updateItem(item.id, { name })
  },
  move: async (path: string, destination: string) => {
    const item = await resolvePath(path)
    const parent = await resolvePath(parentPath(destination))
    await updateItem(item.id, { parent_id: parent.id, name: baseName(destination) || item.name })
  },
  remove: async (path: string) => {
    const item = await resolvePath(path)
    await request<void>(`/api/items/${item.id}`, { method: 'DELETE' })
  },
  preferences: () => request<Record<string, unknown>>('/api/preferences'),
  theme: async () => {
    const values = await request<Record<string, unknown>>('/api/preferences')
    return { theme: (values.theme ?? 'system') as Theme }
  },
  saveTheme: (theme: Theme) =>
    request<Theme>('/api/preferences/theme', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(theme),
    }),
  saveView: (view: ViewMode) =>
    request<ViewMode>('/api/preferences/view', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(view),
    }),
  previewUrl: (id: number) => `/api/files/${id}/content?disposition=inline`,
  downloadUrl: (id: number) => `/api/files/${id}/content`,
  archive: async (id: number, signal?: AbortSignal) => {
    const result = await request<{
      entries: { path: string; size: number; kind: 'file' | 'folder' }[]
    }>(`/api/files/${id}/archive`, { signal })
    return {
      entries: result.entries.map((entry) => ({
        ...entry,
        kind: entry.kind === 'folder' ? 'directory' as const : 'file' as const,
      })),
    }
  },
  debugDatabase: (signal?: AbortSignal) =>
    request<DebugDatabaseInfo>('/api/debug/database', { signal }),
  compactDatabase: () =>
    request<DebugCompactResult>('/api/debug/database/compact', { method: 'POST' }),
  debugRows: (table: string, offset = 0, signal?: AbortSignal) =>
    request<DebugTableRows>(
      `/api/debug/database/${encodeURIComponent(table)}/rows?${new URLSearchParams({ offset: String(offset), limit: '50' })}`,
      { signal },
    ),
  debugCell: (table: string, rowid: number, column: string, signal?: AbortSignal) =>
    request<DebugValue>(
      `/api/debug/database/${encodeURIComponent(table)}/rows/${rowid}/${encodeURIComponent(column)}`,
      { signal },
    ),
  saveDebugCell: (table: string, rowid: number, column: string, value: DebugValue) =>
    request<DebugValue>(
      `/api/debug/database/${encodeURIComponent(table)}/rows/${rowid}/${encodeURIComponent(column)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value),
      },
    ),
}

export function uploadFile(
  directory: string,
  file: File | Blob,
  name: string,
  overwrite: boolean,
  onProgress: (percent: number) => void,
): { promise: Promise<void>; abort: () => void } {
  const xhr = new XMLHttpRequest()
  let cancelled = false
  const promise = (async () => {
    const parent = await resolvePath(directory)
    const targetPath = [...parts(directory), name].join('/')
    const existing = await optionalPath(targetPath)
    if (existing && !overwrite) throw new ApiError('An item with that name already exists', 409)
    if (cancelled) throw new DOMException('Upload cancelled', 'AbortError')

    await new Promise<void>((resolve, reject) => {
      const params = existing
        ? new URLSearchParams({ expected_revision: String(existing.revision) })
        : new URLSearchParams({ parent_id: String(parent.id), name })
      xhr.open(existing ? 'PUT' : 'POST', existing ? `/api/files/${existing.id}/content?${params}` : `/api/files?${params}`)
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream')
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100))
      }
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve()
        else {
          let message = `Upload failed (${xhr.status})`
          try {
            const parsed = JSON.parse(xhr.responseText) as { message?: string; error?: string }
            message = parsed.message || parsed.error || message
          } catch { /* use status message */ }
          reject(new ApiError(message, xhr.status))
        }
      }
      xhr.onerror = () => reject(new ApiError('Network error during upload', 0))
      xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'))
      xhr.send(file)
    })
  })()
  return {
    promise,
    abort: () => {
      cancelled = true
      xhr.abort()
    },
  }
}
