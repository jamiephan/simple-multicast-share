export function normalizePath(path: string): string {
  const parts = path.replaceAll('\\', '/').split('/').filter(Boolean)
  const safe: string[] = []
  for (const part of parts) {
    if (part === '.') continue
    if (part === '..') safe.pop()
    else safe.push(part)
  }
  return safe.join('/')
}

export function joinPath(...parts: string[]): string {
  return normalizePath(parts.join('/'))
}

export function parentPath(path: string): string {
  return normalizePath(path).split('/').slice(0, -1).join('/')
}

export function basename(path: string): string {
  return normalizePath(path).split('/').at(-1) ?? ''
}

export function formatBytes(value: number | null): string {
  if (value == null) return '—'
  if (value === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
  return `${(value / 1024 ** exponent).toFixed(exponent ? 1 : 0)} ${units[exponent]}`
}
