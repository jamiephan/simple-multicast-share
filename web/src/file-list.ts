import { modelExtensions } from './model'
import { officeKind } from './office'
import type { FileEntry } from './types'

export type FileVisualEntry = Pick<FileEntry, 'name' | 'kind' | 'mime'>

export type FileVisualType =
  | 'folder'
  | 'image'
  | 'audio'
  | 'video'
  | 'pdf'
  | 'archive'
  | 'code'
  | 'text'
  | 'model'
  | 'word'
  | 'spreadsheet'
  | 'presentation'
  | 'file'

export type SortField = 'name' | 'type' | 'size' | 'modified'
export type SortDirection = 'asc' | 'desc'

const archiveExtensions = new Set(['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar'])
const codeExtensions = new Set([
  'c', 'cc', 'cpp', 'cs', 'css', 'go', 'h', 'hpp', 'html', 'htm', 'java', 'js', 'jsx',
  'json', 'kt', 'lua', 'php', 'py', 'rb', 'rs', 'sh', 'sql', 'swift', 'toml', 'ts',
  'tsx', 'vue', 'xml', 'yaml', 'yml',
])
const textExtensions = new Set(['txt', 'md', 'markdown', 'csv', 'log'])

function extension(name: string) {
  return name.split('.').pop()?.toLowerCase() ?? ''
}

export function fileVisualType(entry: FileVisualEntry): FileVisualType {
  if (entry.kind === 'directory') return 'folder'
  const suffix = extension(entry.name)
  if (entry.mime?.startsWith('image/')) return 'image'
  if (entry.mime?.startsWith('audio/')) return 'audio'
  if (entry.mime?.startsWith('video/')) return 'video'
  if (entry.mime === 'application/pdf' || suffix === 'pdf') return 'pdf'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif'].includes(suffix)) return 'image'
  if (['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a'].includes(suffix)) return 'audio'
  if (['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v'].includes(suffix)) return 'video'
  if (archiveExtensions.has(suffix)) return 'archive'
  if (modelExtensions.has(suffix)) return 'model'
  const office = officeKind(suffix)
  if (office === 'word' || (office === 'legacy' && suffix === 'doc')) return 'word'
  if (office === 'spreadsheet') return 'spreadsheet'
  if (office === 'presentation' || (office === 'legacy' && suffix === 'ppt')) return 'presentation'
  if (codeExtensions.has(suffix)) return 'code'
  if (entry.mime?.startsWith('text/') || textExtensions.has(suffix)) return 'text'
  return 'file'
}

const fileTypeLabels: Record<FileVisualType, string> = {
  folder: 'Folder',
  image: 'Image',
  audio: 'Audio',
  video: 'Video',
  pdf: 'PDF',
  archive: 'Archive',
  code: 'Source code',
  text: 'Text',
  model: '3D model',
  word: 'Word document',
  spreadsheet: 'Spreadsheet',
  presentation: 'Presentation',
  file: 'File',
}

export function fileTypeLabel(entry: FileEntry) {
  return fileTypeLabels[fileVisualType(entry)]
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

export function sortFileEntries(
  entries: FileEntry[],
  field: SortField,
  direction: SortDirection,
) {
  const multiplier = direction === 'asc' ? 1 : -1
  return [...entries].sort((left, right) => {
    const folderOrder = Number(right.kind === 'directory') - Number(left.kind === 'directory')
    if (folderOrder !== 0) return folderOrder

    let compared = 0
    if (field === 'name') compared = collator.compare(left.name, right.name)
    else if (field === 'type') compared = collator.compare(fileTypeLabel(left), fileTypeLabel(right))
    else if (field === 'size') compared = (left.size ?? 0) - (right.size ?? 0)
    else compared = Date.parse(left.modified) - Date.parse(right.modified)
    if (!Number.isFinite(compared)) compared = 0
    return compared * multiplier || collator.compare(left.name, right.name)
  })
}
