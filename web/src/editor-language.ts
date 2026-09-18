import type { Language, LanguageSupport } from '@codemirror/language'

export interface EditorLanguage {
  name: string
  load: () => Promise<Language | LanguageSupport>
}

const language = (
  name: string,
  load: () => Promise<Language | LanguageSupport>,
): EditorLanguage => ({ name, load })

export function languageForFilename(filename: string): EditorLanguage | null {
  const lower = filename.toLowerCase()
  const extension = lower.includes('.') ? lower.split('.').pop() ?? '' : lower
  switch (extension) {
    case 'js':
    case 'jsx':
      return language('JavaScript', async () => (await import('@codemirror/lang-javascript')).javascript({ jsx: true }))
    case 'ts':
    case 'tsx':
      return language('TypeScript', async () => (await import('@codemirror/lang-javascript')).javascript({ typescript: true, jsx: extension === 'tsx' }))
    case 'json':
      return language('JSON', async () => (await import('@codemirror/lang-json')).json())
    case 'html':
    case 'htm':
      return language('HTML', async () => (await import('@codemirror/lang-html')).html())
    case 'css':
      return language('CSS', async () => (await import('@codemirror/lang-css')).css())
    case 'md':
    case 'markdown':
      return language('Markdown', async () => (await import('@codemirror/lang-markdown')).markdown())
    case 'py':
      return language('Python', async () => (await import('@codemirror/lang-python')).python())
    case 'rs':
      return language('Rust', async () => (await import('@codemirror/lang-rust')).rust())
    case 'yaml':
    case 'yml':
      return language('YAML', async () => (await import('@codemirror/lang-yaml')).yaml())
    case 'xml':
      return language('XML', async () => (await import('@codemirror/lang-xml')).xml())
    case 'go':
      return language('Go', async () => (await import('@codemirror/lang-go')).go())
    case 'sql':
      return language('SQL', async () => (await import('@codemirror/lang-sql')).sql())
    case 'toml':
      return language('TOML', async () => {
        const [{ StreamLanguage }, { toml }] = await Promise.all([
          import('@codemirror/language'),
          import('@codemirror/legacy-modes/mode/toml'),
        ])
        return StreamLanguage.define(toml)
      })
    case 'sh':
    case 'bash':
    case 'zsh':
      return language('Shell', async () => {
        const [{ StreamLanguage }, { shell }] = await Promise.all([
          import('@codemirror/language'),
          import('@codemirror/legacy-modes/mode/shell'),
        ])
        return StreamLanguage.define(shell)
      })
    default:
      return null
  }
}
