export const modelExtensions = new Set(['stl', 'obj', 'fbx', 'gltf', 'glb'])

export const modelResourceRoot = 'model-assets:///'

export function normalizeModelResource(value: string) {
  try {
    const decoded = decodeURIComponent(value.split(/[?#]/, 1)[0])
    const relative = decoded.startsWith(modelResourceRoot)
      ? decoded.slice(modelResourceRoot.length)
      : decoded
    const parts: string[] = []
    for (const part of relative.replaceAll('\\', '/').split('/')) {
      if (!part || part === '.') continue
      if (part === '..') parts.pop()
      else parts.push(part)
    }
    return parts.join('/')
  } catch {
    return value
  }
}
