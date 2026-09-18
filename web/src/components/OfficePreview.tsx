import { FileWarning, Presentation, Sheet, Text } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { officeKind } from '../office'
import { formatBytes } from '../path'
import type { FileEntry } from '../types'

const MAX_OFFICE_PREVIEW_BYTES = 100 * 1024 * 1024
const MAX_SHEET_ROWS = 500
const MAX_SHEET_COLUMNS = 100

interface OfficePreviewProps {
  entry: FileEntry
  extension: string
}

interface SheetPreview {
  name: string
  rows: string[][]
  truncated: boolean
}

export function OfficePreview({ entry, extension }: OfficePreviewProps) {
  const host = useRef<HTMLDivElement>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [sheets, setSheets] = useState<SheetPreview[]>([])
  const [activeSheet, setActiveSheet] = useState(0)
  const kind = officeKind(extension)

  useEffect(() => {
    const container = host.current
    const controller = new AbortController()
    let destroyed = false
    let destroyPresentation: (() => void) | undefined

    const load = async () => {
      setLoading(true)
      setError('')
      setSheets([])
      if (kind === 'legacy') {
        throw new Error(
          `Legacy .${extension} files require a native Office conversion engine. Save this file as ${
            extension === 'doc' ? '.docx' : '.pptx'
          } to preview it locally.`,
        )
      }
      if (!kind) throw new Error('This Office format is not supported.')
      if ((entry.size ?? 0) > MAX_OFFICE_PREVIEW_BYTES) {
        throw new Error(`Office preview is limited to ${formatBytes(MAX_OFFICE_PREVIEW_BYTES)}.`)
      }
      if (extension !== 'xls') {
        await api.archive(entry.id, controller.signal)
      }
      const response = await fetch(api.previewUrl(entry.id), { signal: controller.signal })
      if (!response.ok) throw new Error(`Could not load document (${response.status}).`)
      const buffer = await response.arrayBuffer()
      if (destroyed) return

      if (kind === 'word') {
        if (!container) throw new Error('Word preview container is unavailable.')
        const { renderAsync } = await import('docx-preview')
        if (destroyed) return
        container.replaceChildren()
        await renderAsync(buffer, container, container, {
          breakPages: true,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderEndnotes: true,
          useBase64URL: true,
        })
      } else if (kind === 'spreadsheet') {
        const XLSX = await import('@e965/xlsx')
        const workbook = XLSX.read(buffer, { type: 'array', cellDates: true })
        const previews = workbook.SheetNames.map((name) => {
          const allRows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[name], {
            header: 1,
            raw: false,
            defval: '',
          })
          const truncated = allRows.length > MAX_SHEET_ROWS
            || allRows.some((row) => row.length > MAX_SHEET_COLUMNS)
          return {
            name,
            truncated,
            rows: allRows
              .slice(0, MAX_SHEET_ROWS)
              .map((row) => row.slice(0, MAX_SHEET_COLUMNS).map((cell) => String(cell))),
          }
        })
        if (!destroyed) {
          setActiveSheet(0)
          setSheets(previews)
        }
      } else {
        if (!container) throw new Error('Presentation preview container is unavailable.')
        const { PptxViewer, RECOMMENDED_ZIP_LIMITS } = await import('@aiden0z/pptx-renderer')
        if (destroyed) return
        container.replaceChildren()
        const viewer = await PptxViewer.open(buffer, container, {
          zipLimits: RECOMMENDED_ZIP_LIMITS,
          pdfjs: false,
          lazySlides: true,
          lazyMedia: true,
          listOptions: { windowed: true, initialSlides: 4, batchSize: 4 },
        })
        destroyPresentation = () => viewer.destroy()
      }
      if (!destroyed) setLoading(false)
    }

    load().catch((caught: unknown) => {
      if (!(caught instanceof DOMException && caught.name === 'AbortError') && !destroyed) {
        setError(caught instanceof Error ? caught.message : 'Could not preview Office document')
        setLoading(false)
      }
    })

    return () => {
      destroyed = true
      controller.abort()
      destroyPresentation?.()
      container?.replaceChildren()
    }
  }, [entry.id, entry.size, extension, kind])

  const sheet = sheets[activeSheet]
  return (
    <div className={`office-preview ${kind ?? 'unknown'}`}>
      {kind === 'spreadsheet' && sheets.length > 0 && <div className="sheet-tabs" role="tablist" aria-label="Workbook sheets">
        {sheets.map((item, index) => (
          <button key={item.name} role="tab" aria-selected={activeSheet === index} onClick={() => setActiveSheet(index)}>
            <Sheet size={14} />{item.name}
          </button>
        ))}
      </div>}
      {kind !== 'spreadsheet' && <div ref={host} className="office-document" />}
      {kind === 'spreadsheet' && sheet && <div className="sheet-view">
        <table>
          <tbody>{sheet.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              <th>{rowIndex + 1}</th>
              {row.map((cell, columnIndex) => <td key={columnIndex}>{cell}</td>)}
            </tr>
          ))}</tbody>
        </table>
        {sheet.truncated && <p className="office-limit">Preview limited to the first {MAX_SHEET_ROWS} rows and {MAX_SHEET_COLUMNS} columns.</p>}
      </div>}
      {loading && <div className="office-status"><div className="spinner" />Loading Office preview…</div>}
      {error && <div className="office-status error">
        <FileWarning size={36} />
        <strong>Preview unavailable</strong>
        <span>{error}</span>
      </div>}
      {!loading && !error && kind === 'word' && <div className="office-kind"><Text size={14} />Word document</div>}
      {!loading && !error && kind === 'presentation' && <div className="office-kind"><Presentation size={14} />Presentation</div>}
    </div>
  )
}
