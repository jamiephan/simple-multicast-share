import { describe, expect, it } from 'vitest'
import { officeKind } from './office'

describe('Office preview classification', () => {
  it.each([
    ['report.docx', 'word'],
    ['workbook.xlsx', 'spreadsheet'],
    ['legacy.xls', 'spreadsheet'],
    ['slides.pptx', 'presentation'],
    ['legacy.doc', 'legacy'],
    ['legacy.ppt', 'legacy'],
  ])('classifies %s as %s', (filename, kind) => {
    expect(officeKind(filename.split('.').pop() ?? '')).toBe(kind)
  })
})
