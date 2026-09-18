import { useEffect, useState } from 'react'
import type { Language, LanguageSupport } from '@codemirror/language'
import { oneDark } from '@codemirror/theme-one-dark'
import CodeMirror from '@uiw/react-codemirror'
import { languageForFilename } from '../editor-language'

interface CodeEditorProps {
  filename: string
  value: string
  dark: boolean
  onChange: (value: string) => void
}

export function CodeEditor({ filename, value, dark, onChange }: CodeEditorProps) {
  const [language, setLanguage] = useState<Language | LanguageSupport | null>(null)
  const [loadingLanguage, setLoadingLanguage] = useState(true)

  useEffect(() => {
    let active = true
    const description = languageForFilename(filename)
    if (!description) {
      setLanguage(null)
      setLoadingLanguage(false)
      return () => { active = false }
    }
    setLoadingLanguage(true)
    description.load()
      .then((support) => {
        if (active) setLanguage(support)
      })
      .catch(() => {
        if (active) setLanguage(null)
      })
      .finally(() => {
        if (active) setLoadingLanguage(false)
      })
    return () => { active = false }
  }, [filename])

  return (
    <div className="code-editor">
      <CodeMirror
        value={value}
        height="min(570px, 65vh)"
        theme={dark ? oneDark : 'light'}
        extensions={language ? [language] : []}
        basicSetup={{
          lineNumbers: true,
          foldGutter: true,
          highlightActiveLine: true,
          highlightActiveLineGutter: true,
          bracketMatching: true,
          closeBrackets: true,
          autocompletion: true,
          rectangularSelection: true,
          crosshairCursor: true,
          searchKeymap: true,
          foldKeymap: true,
          completionKeymap: true,
          lintKeymap: true,
        }}
        onChange={onChange}
      />
      <span className="code-language">
        {loadingLanguage ? 'Detecting syntax…' : languageForFilename(filename)?.name ?? 'Plain text'}
      </span>
    </div>
  )
}
