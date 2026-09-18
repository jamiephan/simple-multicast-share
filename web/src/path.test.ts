import { describe, expect, it } from 'vitest'
import { basename, formatBytes, joinPath, normalizePath, parentPath } from './path'

describe('path helpers', () => {
  it('normalizes separators and traversal', () => {
    expect(normalizePath('/photos/./2025/../2026/')).toBe('photos/2026')
    expect(joinPath('photos/', '/summer.jpg')).toBe('photos/summer.jpg')
  })
  it('finds parent and base names', () => {
    expect(parentPath('a/b/c.txt')).toBe('a/b')
    expect(basename('a/b/c.txt')).toBe('c.txt')
  })
  it('formats byte counts', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
  })
})
