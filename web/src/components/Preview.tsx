import { Archive, Download, Eye, FileQuestion, Image as ImageIcon, Pencil, Save } from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { modelExtensions } from '../model'
import { officeKind } from '../office'
import { formatBytes, joinPath, parentPath } from '../path'
import { previewType, previewTypes, type PreviewCategory } from '../preview-types'
import type { FileEntry } from '../types'
import { ImageEditor } from './ImageEditor'
import { Modal, PromptDialog } from './Modal'

const ModelPreview = lazy(() => import('./ModelPreview').then((module) => ({ default: module.ModelPreview })))
const CodeEditor = lazy(() => import('./CodeEditor').then((module) => ({ default: module.CodeEditor })))
const OfficePreview = lazy(() => import('./OfficePreview').then((module) => ({ default: module.OfficePreview })))

const ext = (name: string) => name.split('.').pop()?.toLowerCase() ?? ''
const imageExt = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif'])
const textExt = new Set(['txt', 'md', 'markdown', 'json', 'toml', 'yaml', 'yml', 'csv', 'log', 'xml', 'html', 'htm', 'css', 'js', 'jsx', 'ts', 'tsx', 'rs', 'go', 'py', 'sh', 'bash', 'zsh', 'sql'])
const archiveExt = new Set(['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar'])

interface PreviewProps {
  entry: FileEntry
  dark: boolean
  onClose: () => void
  onChanged: () => void
  onSaveImage: (blob: Blob, name: string) => Promise<void>
}

export function Preview({ entry, dark, onClose, onChanged, onSaveImage }: PreviewProps) {
  const extension = ext(entry.name)
  const detectedCategory = useMemo<PreviewCategory>(() => {
    if (entry.mime?.startsWith('image/') || imageExt.has(extension)) return 'image'
    if (entry.mime?.startsWith('audio/')) return 'audio'
    if (entry.mime?.startsWith('video/')) return 'video'
    if (entry.mime === 'application/pdf' || extension === 'pdf') return 'pdf'
    if (archiveExt.has(extension)) return 'archive'
    if (modelExtensions.has(extension)) return 'model'
    if (officeKind(extension)) return 'office'
    if (entry.mime?.startsWith('text/') || textExt.has(extension)) return 'text'
    return 'unknown'
  }, [entry.mime, extension])
  const [selectedPreviewType, setSelectedPreviewType] = useState('text')
  const [forcedPreviewType, setForcedPreviewType] = useState('')
  const [forcedError, setForcedError] = useState('')
  const selectedType = previewType(forcedPreviewType)
  const category = selectedType?.category ?? detectedCategory
  const previewExtension = selectedType?.extension ?? extension
  const previewMime = selectedType?.mime
  const isForced = Boolean(selectedType)
  const [editingImage, setEditingImage] = useState(false)
  const [text, setText] = useState('')
  const [archive, setArchive] = useState<{ path: string; size: number; kind: 'file' | 'directory' }[]>([])
  const [loading, setLoading] = useState(category === 'text' || category === 'archive')
  const [saving, setSaving] = useState(false)
  const [saveChoice, setSaveChoice] = useState<'choice' | 'save-as' | null>(null)
  const [error, setError] = useState('')
  const reportForcedError = useCallback((message: string) => {
    if (isForced) setForcedError(message)
  }, [isForced])

  useEffect(() => {
    const controller = new AbortController()
    setError('')
    if (category === 'text') {
      setLoading(true)
      api.readText(entry.path, controller.signal).then(setText).catch((caught: unknown) => {
        if (!(caught instanceof DOMException && caught.name === 'AbortError')) {
          const message = caught instanceof Error ? caught.message : 'Could not read text file'
          setError(message)
          reportForcedError(message)
        }
      }).finally(() => setLoading(false))
    } else if (category === 'archive') {
      setLoading(true)
      api.archive(entry.id, controller.signal, isForced ? previewExtension : undefined).then((result) => setArchive(result.entries)).catch((caught: unknown) => {
        if (!(caught instanceof DOMException && caught.name === 'AbortError')) {
          const message = caught instanceof Error ? caught.message : 'Could not inspect archive'
          setError(message)
          reportForcedError(message)
        }
      }).finally(() => setLoading(false))
    } else if (category === 'pdf' && isForced) {
      setLoading(true)
      fetch(api.previewUrl(entry.id, previewMime), {
        signal: controller.signal,
        headers: { Range: 'bytes=0-4' },
      }).then(async (response) => {
        if (!response.ok) throw new Error(`Could not inspect PDF (${response.status})`)
        const signature = new TextDecoder().decode(await response.arrayBuffer())
        if (signature !== '%PDF-') throw new Error('The file does not have a valid PDF signature.')
      }).catch((caught: unknown) => {
        if (!(caught instanceof DOMException && caught.name === 'AbortError')) {
          const message = caught instanceof Error ? caught.message : 'Could not inspect PDF'
          setError(message)
          reportForcedError(message)
        }
      }).finally(() => setLoading(false))
    } else {
      setLoading(false)
    }
    return () => controller.abort()
  }, [category, entry.id, entry.path, isForced, previewExtension, previewMime, reportForcedError])

  const saveText = async (newName?: string) => {
    setSaving(true)
    setError('')
    try {
      if (newName) {
        await api.createText(joinPath(parentPath(entry.path), newName), text)
      } else {
        await api.saveText(entry.path, text)
      }
      setSaveChoice(null)
      onChanged()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save file')
    } finally {
      setSaving(false)
    }
  }

  const content = () => {
    if (loading) return <div className="empty-state"><div className="spinner" />Loading preview…</div>
    if (error) return <div className="alert error" role="alert">{error}</div>
    const url = api.previewUrl(entry.id, previewMime)
    switch (category) {
      case 'image': return <div className="media-preview"><img src={url} alt={entry.name} onError={() => reportForcedError('The browser could not decode this file as the selected image format.')} /></div>
      case 'audio': return <div className="media-preview"><audio src={url} controls autoPlay={false} onError={() => reportForcedError('The browser could not decode this file as the selected audio format.')}>Your browser cannot play this audio.</audio></div>
      case 'video': return <div className="media-preview"><video src={url} controls onError={() => reportForcedError('The browser could not decode this file as the selected video format.')}>Your browser cannot play this video.</video></div>
      case 'pdf': return <iframe className="pdf-preview" src={url} title={`Preview of ${entry.name}`} />
      case 'text': return <Suspense fallback={<div className="empty-state"><div className="spinner" />Preparing editor…</div>}><CodeEditor filename={entry.name} value={text} dark={dark} onChange={setText} /></Suspense>
      case 'archive': return (
        <div className="archive-list">
          <div className="archive-heading"><Archive size={18} /> {archive.length} archive entries</div>
          {archive.map((item, index) => <div className="archive-row" key={`${item.path}-${index}`}><span>{item.path}{item.kind === 'directory' ? '/' : ''}</span><span>{item.kind === 'file' ? formatBytes(item.size) : ''}</span></div>)}
        </div>
      )
      case 'model': return <Suspense fallback={<div className="empty-state"><div className="spinner" />Preparing 3D viewer…</div>}><ModelPreview entry={entry} extension={previewExtension} onError={reportForcedError} /></Suspense>
      case 'office': return <Suspense fallback={<div className="empty-state"><div className="spinner" />Preparing Office viewer…</div>}><OfficePreview entry={entry} extension={previewExtension} onError={reportForcedError} /></Suspense>
      default: return <div className="empty-state unknown-preview">
        <FileQuestion size={44} />
        <h3>No preview type detected</h3>
        <p>Choose a format to try opening this file without changing its name or contents.</p>
        <div className="open-as">
          <label>
            <span className="sr-only">Preview type</span>
            <select value={selectedPreviewType} onChange={(event) => setSelectedPreviewType(event.target.value)}>
              {[...new Set(previewTypes.map((type) => type.group))].map((group) => (
                <optgroup key={group} label={group}>
                  {previewTypes.filter((type) => type.group === group).map((type) => (
                    <option key={type.value} value={type.value}>{type.label}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <button className="button primary" onClick={() => {
            setError('')
            setForcedError('')
            setForcedPreviewType(selectedPreviewType)
          }}><Eye size={16} />Try preview</button>
        </div>
      </div>
    }
  }

  if (editingImage) return <ImageEditor url={api.previewUrl(entry.id)} name={entry.name} onClose={() => setEditingImage(false)} onSave={onSaveImage} />
  return (
    <>
    <Modal title={entry.name} onClose={onClose} wide footer={
      <>
        <a className="button secondary" href={api.downloadUrl(entry.id)} download><Download size={16} />Download</a>
        {category === 'image' && <button className="button secondary" onClick={() => setEditingImage(true)}><ImageIcon size={16} />Crop & annotate</button>}
        {category === 'text' && <button className="button primary" disabled={saving} onClick={() => setSaveChoice('choice')}><Save size={16} />{saving ? 'Saving…' : 'Save changes'}</button>}
        {category !== 'text' && category !== 'image' && <button className="button primary" onClick={onClose}>Done</button>}
      </>
    }>
      <div className="preview">{content()}</div>
      {isForced && <div className="forced-preview-bar">
        <span>Opened as {selectedType?.label}</span>
        <button onClick={() => {
          setForcedPreviewType('')
          setForcedError('')
          setError('')
        }}>Choose another type</button>
      </div>}
      {category === 'text' && <p className="hint"><Pencil size={14} /> UTF-8 text editor with overwrite and save-as-new options.</p>}
    </Modal>
    {saveChoice === 'choice' && <Modal title="Save text file" onClose={() => setSaveChoice(null)} footer={
      <>
        <button className="button secondary" onClick={() => setSaveChoice(null)}>Cancel</button>
        <button className="button secondary" onClick={() => setSaveChoice('save-as')}>Save as new</button>
        <button className="button primary" onClick={() => void saveText()}>Overwrite</button>
      </>
    }><p>Overwrite “{entry.name}” or save the edited text as a new file?</p></Modal>}
    {saveChoice === 'save-as' && <PromptDialog
      title="Save text as new"
      label="File name"
      value={`copy of ${entry.name}`}
      confirmLabel="Save as new"
      onClose={() => setSaveChoice(null)}
      onConfirm={(name) => void saveText(name)}
    />}
    {forcedError && <Modal title="Preview failed" onClose={() => setForcedError('')} footer={
      <>
        <button className="button secondary" onClick={() => {
          setForcedError('')
          setForcedPreviewType('')
          setError('')
        }}>Choose another type</button>
        <button className="button primary" onClick={() => setForcedError('')}>Close</button>
      </>
    }>
      <p>“{entry.name}” could not be opened as {selectedType?.label ?? 'the selected type'}.</p>
      <p className="danger-text">{forcedError}</p>
    </Modal>}
    </>
  )
}
