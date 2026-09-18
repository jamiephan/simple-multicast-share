import { Box, Focus, Grid3X3, Rotate3D } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { api } from '../api'
import { modelResourceRoot, normalizeModelResource } from '../model'
import type { FileEntry } from '../types'

interface ModelPreviewProps {
  entry: FileEntry
  extension: string
  onError?: (message: string) => void
}

function disposeObject(object: THREE.Object3D) {
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return
    child.geometry?.dispose()
    const materials = Array.isArray(child.material) ? child.material : [child.material]
    for (const material of materials) {
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) value.dispose()
      }
      material.dispose()
    }
  })
}

export function ModelPreview({ entry, extension, onError }: ModelPreviewProps) {
  const host = useRef<HTMLDivElement>(null)
  const resetView = useRef<() => void>(() => undefined)
  const model = useRef<THREE.Object3D | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [wireframe, setWireframe] = useState(false)
  const [grid, setGrid] = useState(true)

  useEffect(() => {
    const container = host.current
    if (!container) return
    const controller = new AbortController()
    let disposed = false
    let frame = 0
    let mixer: THREE.AnimationMixer | undefined

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x20242c)
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100000)
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    container.appendChild(renderer.domElement)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    const gridHelper = new THREE.GridHelper(10, 10, 0x718096, 0x4a5568)
    gridHelper.name = '__preview_grid'
    scene.add(gridHelper)
    scene.add(new THREE.HemisphereLight(0xffffff, 0x303845, 2.5))
    const directional = new THREE.DirectionalLight(0xffffff, 3)
    directional.position.set(4, 7, 5)
    scene.add(directional)

    const resize = () => {
      const width = Math.max(container.clientWidth, 1)
      const height = Math.max(container.clientHeight, 1)
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(container)
    resize()

    const clock = new THREE.Clock()
    const animate = () => {
      frame = requestAnimationFrame(animate)
      mixer?.update(clock.getDelta())
      controls.update()
      renderer.render(scene, camera)
    }
    animate()

    const frameModel = (object: THREE.Object3D) => {
      const bounds = new THREE.Box3().setFromObject(object)
      if (bounds.isEmpty()) throw new Error('The model contains no visible geometry.')
      const center = bounds.getCenter(new THREE.Vector3())
      const size = bounds.getSize(new THREE.Vector3())
      const radius = Math.max(size.length() / 2, 0.01)
      object.position.sub(center)
      controls.target.set(0, 0, 0)
      camera.near = Math.max(radius / 1000, 0.001)
      camera.far = Math.max(radius * 100, 100)
      camera.position.set(radius * 1.6, radius * 1.15, radius * 1.6)
      camera.updateProjectionMatrix()
      controls.minDistance = radius * 0.02
      controls.maxDistance = radius * 20
      controls.update()
      gridHelper.scale.setScalar(Math.max(radius / 5, 0.1))
      gridHelper.position.y = -size.y / 2
    }
    resetView.current = () => model.current && frameModel(model.current)

    const load = async () => {
      const assets = await api.modelAssets(entry.path, controller.signal)
      const manager = new THREE.LoadingManager()
      manager.setURLModifier((url) => {
        if (url.startsWith('data:') || url.startsWith('blob:')) return url
        return assets.get(normalizeModelResource(url)) ?? `model-assets:///missing/${encodeURIComponent(url)}`
      })
      const response = await fetch(api.previewUrl(entry.id), { signal: controller.signal })
      if (!response.ok) throw new Error(`Could not load model (${response.status})`)
      const buffer = await response.arrayBuffer()
      let object: THREE.Object3D
      let animations: THREE.AnimationClip[] = []

      if (extension === 'stl') {
        const geometry = new STLLoader(manager).parse(buffer)
        geometry.computeVertexNormals()
        object = new THREE.Mesh(
          geometry,
          new THREE.MeshStandardMaterial({ color: 0x769cff, roughness: 0.65, metalness: 0.1 }),
        )
      } else if (extension === 'obj') {
        const source = new TextDecoder().decode(buffer)
        const materialFile = source.match(/^\s*mtllib\s+(.+)$/im)?.[1]?.trim()
        const loader = new OBJLoader(manager)
        if (materialFile) {
          const normalizedMaterial = normalizeModelResource(materialFile)
          const materialUrl = assets.get(normalizedMaterial)
          if (materialUrl) {
            const materialResponse = await fetch(materialUrl, { signal: controller.signal })
            if (!materialResponse.ok) throw new Error(`Could not load OBJ material library “${materialFile}”.`)
            const materialDirectory = normalizedMaterial.includes('/')
              ? normalizedMaterial.slice(0, normalizedMaterial.lastIndexOf('/') + 1)
              : ''
            const materials = new MTLLoader(manager).parse(
              await materialResponse.text(),
              `${modelResourceRoot}${materialDirectory}`,
            )
            materials.preload()
            loader.setMaterials(materials)
          }
        }
        object = loader.parse(source)
      } else if (extension === 'fbx') {
        object = new FBXLoader(manager).parse(buffer, modelResourceRoot)
        animations = object.animations
      } else {
        const gltf = await new Promise<Awaited<ReturnType<GLTFLoader['parseAsync']>>>((resolve, reject) => {
          new GLTFLoader(manager).parse(buffer, modelResourceRoot, resolve, reject)
        })
        object = gltf.scene
        animations = gltf.animations
      }

      if (disposed) {
        disposeObject(object)
        return
      }
      model.current = object
      scene.add(object)
      frameModel(object)
      if (animations.length) {
        mixer = new THREE.AnimationMixer(object)
        for (const clip of animations) mixer.clipAction(clip).play()
      }
      setLoading(false)
    }
    load().catch((caught: unknown) => {
      if (!(caught instanceof DOMException && caught.name === 'AbortError')) {
        const message = caught instanceof Error ? caught.message : 'Could not load 3D model'
        setError(message)
        onError?.(message)
        setLoading(false)
      }
    })

    return () => {
      disposed = true
      controller.abort()
      cancelAnimationFrame(frame)
      observer.disconnect()
      controls.dispose()
      mixer?.stopAllAction()
      if (model.current) {
        scene.remove(model.current)
        disposeObject(model.current)
        model.current = null
      }
      renderer.dispose()
      renderer.domElement.remove()
    }
  }, [entry.id, entry.path, extension, onError])

  useEffect(() => {
    model.current?.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return
      const materials = Array.isArray(child.material) ? child.material : [child.material]
      for (const material of materials) {
        if ('wireframe' in material) {
          ;(material as THREE.MeshStandardMaterial).wireframe = wireframe
          material.needsUpdate = true
        }
      }
    })
  }, [wireframe])

  return (
    <div className="model-preview">
      <div className="model-toolbar">
        <span><Box size={16} />3D preview</span>
        <button className="button secondary" onClick={() => resetView.current()}><Focus size={16} />Reset view</button>
        <button className="button secondary" aria-pressed={wireframe} onClick={() => setWireframe((value) => !value)}><Rotate3D size={16} />Wireframe</button>
        <button className="button secondary" aria-pressed={grid} onClick={() => {
          setGrid((value) => {
            const next = !value
            const helper = model.current?.parent?.getObjectByName('__preview_grid')
            if (helper) helper.visible = next
            return next
          })
        }}><Grid3X3 size={16} />Grid</button>
      </div>
      <div ref={host} className="model-canvas" />
      {loading && <div className="model-status"><div className="spinner" />Loading 3D model…</div>}
      {error && <div className="model-status error"><FileError />{error}</div>}
      {!loading && !error && <p className="model-help">Drag to rotate, scroll or pinch to zoom, and right-drag to pan.</p>}
    </div>
  )
}

function FileError() {
  return <span aria-hidden="true">!</span>
}
