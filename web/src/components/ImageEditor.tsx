import { ArrowUpRight, Crop, Download, Minus, MousePointer2, Pencil, Redo2, Save, Square, Type, Undo2 } from 'lucide-react'
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react'
import { Modal } from './Modal'

type Tool = 'pen' | 'arrow' | 'rect' | 'text' | 'crop'
type Point = { x: number; y: number }

interface ImageEditorProps {
  url: string
  name: string
  onClose: () => void
  onSave: (blob: Blob, name: string) => Promise<void>
}

export function ImageEditor({ url, name, onClose, onSave }: ImageEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const snapshot = useRef<ImageData | null>(null)
  const history = useRef<ImageData[]>([])
  const future = useRef<ImageData[]>([])
  const start = useRef<Point | null>(null)
  const [tool, setTool] = useState<Tool>('pen')
  const [color, setColor] = useState('#ef4444')
  const [width, setWidth] = useState(4)
  const [text, setText] = useState('Note')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const image = new Image()
    image.onload = () => {
      const canvas = canvasRef.current
      if (!canvas) return
      const scale = Math.min(1, 1800 / Math.max(image.naturalWidth, image.naturalHeight))
      canvas.width = Math.round(image.naturalWidth * scale)
      canvas.height = Math.round(image.naturalHeight * scale)
      canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height)
    }
    image.onerror = () => setError('The image could not be loaded.')
    image.src = url
  }, [url])

  const point = (event: ReactPointerEvent<HTMLCanvasElement>): Point => {
    const canvas = event.currentTarget
    const bounds = canvas.getBoundingClientRect()
    return {
      x: (event.clientX - bounds.left) * canvas.width / bounds.width,
      y: (event.clientY - bounds.top) * canvas.height / bounds.height,
    }
  }

  const pushHistory = () => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    history.current.push(context.getImageData(0, 0, canvas.width, canvas.height))
    if (history.current.length > 30) history.current.shift()
    future.current = []
  }

  const begin = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = event.currentTarget
    const context = canvas.getContext('2d')
    if (!context) return
    pushHistory()
    start.current = point(event)
    snapshot.current = context.getImageData(0, 0, canvas.width, canvas.height)
    canvas.setPointerCapture(event.pointerId)
    if (tool === 'pen') {
      context.beginPath()
      context.moveTo(start.current.x, start.current.y)
    }
  }

  const drawShape = (context: CanvasRenderingContext2D, from: Point, to: Point) => {
    context.strokeStyle = color
    context.fillStyle = color
    context.lineWidth = width
    context.lineCap = 'round'
    context.lineJoin = 'round'
    if (tool === 'rect' || tool === 'crop') {
      if (tool === 'crop') context.setLineDash([8, 6])
      context.strokeRect(from.x, from.y, to.x - from.x, to.y - from.y)
      context.setLineDash([])
    } else if (tool === 'arrow') {
      context.beginPath()
      context.moveTo(from.x, from.y)
      context.lineTo(to.x, to.y)
      const angle = Math.atan2(to.y - from.y, to.x - from.x)
      const head = Math.max(12, width * 4)
      context.lineTo(to.x - head * Math.cos(angle - Math.PI / 6), to.y - head * Math.sin(angle - Math.PI / 6))
      context.moveTo(to.x, to.y)
      context.lineTo(to.x - head * Math.cos(angle + Math.PI / 6), to.y - head * Math.sin(angle + Math.PI / 6))
      context.stroke()
    }
  }

  const move = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!start.current) return
    const context = event.currentTarget.getContext('2d')
    if (!context) return
    const current = point(event)
    context.strokeStyle = color
    context.lineWidth = width
    context.lineCap = 'round'
    if (tool === 'pen') {
      context.lineTo(current.x, current.y)
      context.stroke()
    } else if (snapshot.current) {
      context.putImageData(snapshot.current, 0, 0)
      drawShape(context, start.current, current)
    }
  }

  const end = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!start.current) return
    const canvas = event.currentTarget
    const context = canvas.getContext('2d')
    const current = point(event)
    if (!context) return
    if (tool === 'text') {
      context.fillStyle = color
      context.font = `${Math.max(14, width * 5)}px system-ui`
      context.fillText(text || 'Text', current.x, current.y)
    } else if (tool === 'crop' && snapshot.current) {
      context.putImageData(snapshot.current, 0, 0)
      const x = Math.max(0, Math.round(Math.min(start.current.x, current.x)))
      const y = Math.max(0, Math.round(Math.min(start.current.y, current.y)))
      const w = Math.min(canvas.width - x, Math.round(Math.abs(current.x - start.current.x)))
      const h = Math.min(canvas.height - y, Math.round(Math.abs(current.y - start.current.y)))
      if (w > 10 && h > 10) {
        const crop = context.getImageData(x, y, w, h)
        canvas.width = w
        canvas.height = h
        canvas.getContext('2d')?.putImageData(crop, 0, 0)
      }
    }
    start.current = null
    snapshot.current = null
  }

  const restore = (source: ImageData[], target: ImageData[]) => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    const previous = source.pop()
    if (!canvas || !context || !previous) return
    target.push(context.getImageData(0, 0, canvas.width, canvas.height))
    canvas.width = previous.width
    canvas.height = previous.height
    canvas.getContext('2d')?.putImageData(previous, 0, 0)
  }

  const exportBlob = () => new Promise<Blob>((resolve, reject) => {
    canvasRef.current?.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Could not export image')), 'image/png')
  })

  const save = async () => {
    setSaving(true)
    setError('')
    try {
      await onSave(await exportBlob(), name.replace(/\.[^.]+$/, '') + '.png')
      onClose()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save image')
    } finally {
      setSaving(false)
    }
  }

  const tools: [Tool, typeof Pencil, string][] = [
    ['pen', Pencil, 'Freehand'],
    ['arrow', ArrowUpRight, 'Arrow'],
    ['rect', Square, 'Rectangle'],
    ['text', Type, 'Text'],
    ['crop', Crop, 'Crop'],
  ]

  return (
    <Modal title={`Edit ${name}`} onClose={onClose} wide footer={
      <>
        <button className="button secondary" onClick={onClose}>Cancel</button>
        <button className="button primary" disabled={saving} onClick={save}><Save size={16} />{saving ? 'Saving…' : 'Save image'}</button>
      </>
    }>
      <div className="editor-toolbar" aria-label="Image editing tools">
        {tools.map(([id, Icon, label]) => (
          <button key={id} className={`tool ${tool === id ? 'active' : ''}`} onClick={() => setTool(id)} title={label} aria-label={label} aria-pressed={tool === id}>
            <Icon size={18} />
          </button>
        ))}
        <span className="tool-separator" />
        <label title="Annotation color"><span className="sr-only">Color</span><input type="color" value={color} onChange={(event) => setColor(event.target.value)} /></label>
        <label className="compact-field"><Minus size={16} /><input aria-label="Line width" type="range" min="1" max="16" value={width} onChange={(event) => setWidth(Number(event.target.value))} /></label>
        {tool === 'text' && <input className="editor-text" aria-label="Annotation text" value={text} onChange={(event) => setText(event.target.value)} />}
        <span className="toolbar-spacer" />
        <button className="tool" title="Undo" aria-label="Undo" onClick={() => restore(history.current, future.current)}><Undo2 size={18} /></button>
        <button className="tool" title="Redo" aria-label="Redo" onClick={() => restore(future.current, history.current)}><Redo2 size={18} /></button>
        <button className="tool" title="Download edited image" aria-label="Download edited image" onClick={async () => {
          const link = document.createElement('a')
          link.href = URL.createObjectURL(await exportBlob())
          link.download = name.replace(/\.[^.]+$/, '') + '-edited.png'
          link.click()
          URL.revokeObjectURL(link.href)
        }}><Download size={18} /></button>
      </div>
      {error && <div className="alert error" role="alert">{error}</div>}
      <div className="canvas-stage">
        <canvas ref={canvasRef} onPointerDown={begin} onPointerMove={move} onPointerUp={end} onPointerCancel={end} />
      </div>
      <p className="hint"><MousePointer2 size={14} /> Drag on the image to use the selected tool. Cropping is applied when you release.</p>
    </Modal>
  )
}
