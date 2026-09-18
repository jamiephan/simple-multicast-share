import { describe, expect, it } from 'vitest'
import { fileVisualType, sortFileEntries } from './file-list'
import type { FileEntry } from './types'

const entry = (name: string, size: number | null, modified: string, kind: FileEntry['kind'] = 'file'): FileEntry => ({
  id: name.length,
  parentId: 1,
  revision: 1,
  name,
  path: name,
  kind,
  size,
  modified,
})

describe('file list helpers', () => {
  it('assigns semantic icon types', () => {
    expect(fileVisualType(entry('photo.png', 10, '2026-01-01'))).toBe('image')
    expect(fileVisualType(entry('main.rs', 10, '2026-01-01'))).toBe('code')
    expect(fileVisualType(entry('book.xlsx', 10, '2026-01-01'))).toBe('spreadsheet')
    expect(fileVisualType(entry('mesh.glb', 10, '2026-01-01'))).toBe('model')
  })

  it('sorts repeatedly in either direction while keeping folders first', () => {
    const values = [
      entry('small.txt', 2, '2026-01-02'),
      entry('folder', null, '2026-01-01', 'directory'),
      entry('large.txt', 20, '2026-01-03'),
    ]
    expect(sortFileEntries(values, 'size', 'asc').map((item) => item.name))
      .toEqual(['folder', 'small.txt', 'large.txt'])
    expect(sortFileEntries(values, 'size', 'desc').map((item) => item.name))
      .toEqual(['folder', 'large.txt', 'small.txt'])
    expect(sortFileEntries(values, 'modified', 'desc').map((item) => item.name))
      .toEqual(['folder', 'large.txt', 'small.txt'])
  })
})
