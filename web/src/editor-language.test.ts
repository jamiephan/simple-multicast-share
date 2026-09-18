import { describe, expect, it } from 'vitest'
import { languageForFilename } from './editor-language'

describe('editor language detection', () => {
  it.each(['main.rs', 'app.tsx', 'settings.json', 'config.yaml', 'README.md', 'schema.sql'])(
    'detects a language for %s',
    (filename) => expect(languageForFilename(filename)).toBeDefined(),
  )

  it('allows unknown text formats to use the plain editor', () => {
    expect(languageForFilename('notes.unknown-format')).toBeNull()
  })
})
