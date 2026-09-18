export type EntryKind = 'file' | 'directory'

export interface FileEntry {
  id: number
  parentId: number | null
  revision: number
  name: string
  path: string
  kind: EntryKind
  size: number | null
  modified: string
  mime?: string
}

export interface DirectoryListing {
  path: string
  entries: FileEntry[]
}

export type Theme = 'light' | 'dark' | 'system'
export type ViewMode = 'grid' | 'list'

export interface UploadProgress {
  id: string
  name: string
  percent: number
  state: 'uploading' | 'done' | 'error'
  error?: string
}
