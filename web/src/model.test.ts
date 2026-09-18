import { describe, expect, it } from 'vitest'
import { modelExtensions, normalizeModelResource } from './model'

describe('3D model support', () => {
  it('recognizes every supported model extension', () => {
    expect([...modelExtensions]).toEqual(['stl', 'obj', 'fbx', 'gltf', 'glb'])
  })

  it('normalizes same-folder dependency paths', () => {
    expect(normalizeModelResource('model-assets:///textures%2Fwood.png')).toBe('textures/wood.png')
    expect(normalizeModelResource('model-assets:///materials/../textures/wood.png')).toBe('textures/wood.png')
    expect(normalizeModelResource('model-assets:///textures/wood.png?v=2#image')).toBe('textures/wood.png')
  })
})
