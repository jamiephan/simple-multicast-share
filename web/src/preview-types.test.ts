import { describe, expect, it } from 'vitest'
import { previewType, previewTypes } from './preview-types'

describe('forced preview types', () => {
  it('has unique selector values', () => {
    expect(new Set(previewTypes.map((item) => item.value)).size).toBe(previewTypes.length)
  })

  it('maps format-specific parsers', () => {
    expect(previewType('model-fbx')).toMatchObject({ category: 'model', extension: 'fbx' })
    expect(previewType('archive-tgz')).toMatchObject({ category: 'archive', extension: 'tar.gz' })
    expect(previewType('office-xlsx')).toMatchObject({ category: 'office', extension: 'xlsx' })
  })
})
