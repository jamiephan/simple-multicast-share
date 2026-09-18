import { ChevronLeft, ChevronRight, Database, HardDrive, Minimize2, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, type DebugDatabaseInfo, type DebugTableRows, type DebugValue } from '../api'
import { formatBytes } from '../path'
import { Modal } from './Modal'

interface DatabaseInspectorProps {
  onClose: () => void
  onChanged: () => void
}

type ValueType = DebugValue['type']

function summarize(value: DebugValue) {
  switch (value.type) {
    case 'null': return 'NULL'
    case 'blob': return `<BLOB ${value.size.toLocaleString()} bytes>`
    case 'integer':
    case 'real': return String(value.value)
    case 'text': return value.value.length > 100 ? `${value.value.slice(0, 100)}…` : value.value
  }
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return btoa(binary)
}

function base64ToText(value: string) {
  const binary = atob(value)
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

export function DatabaseInspector({ onClose, onChanged }: DatabaseInspectorProps) {
  const [database, setDatabase] = useState<DebugDatabaseInfo | null>(null)
  const [table, setTable] = useState('')
  const [rows, setRows] = useState<DebugTableRows | null>(null)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<{ rowid: number; column: string; value: DebugValue } | null>(null)
  const [editType, setEditType] = useState<ValueType>('text')
  const [editValue, setEditValue] = useState('')
  const [blobEncoding, setBlobEncoding] = useState<'text' | 'base64'>('text')
  const [saving, setSaving] = useState(false)
  const [confirmCompact, setConfirmCompact] = useState(false)
  const [compacting, setCompacting] = useState(false)
  const [compactResult, setCompactResult] = useState('')

  const loadDatabase = useCallback((signal?: AbortSignal) =>
    api.debugDatabase(signal)
      .then((info) => {
        setDatabase(info)
        setTable((current) => current || info.tables.find((candidate) => candidate.name === 'items')?.name || info.tables[0]?.name || '')
      })
  , [])

  useEffect(() => {
    const controller = new AbortController()
    loadDatabase(controller.signal)
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : 'Could not inspect database'))
    return () => controller.abort()
  }, [loadDatabase])

  const loadRows = useCallback(async () => {
    if (!table) return
    setLoading(true)
    setError('')
    try {
      setRows(await api.debugRows(table, offset))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load table rows')
    } finally {
      setLoading(false)
    }
  }, [offset, table])

  useEffect(() => { void loadRows() }, [loadRows])

  const schema = useMemo(
    () => database?.tables.find((candidate) => candidate.name === table),
    [database, table],
  )

  const edit = async (rowid: number, column: string, summary: DebugValue) => {
    setError('')
    try {
      const value = summary.type === 'blob' ? await api.debugCell(table, rowid, column) : summary
      setEditing({ rowid, column, value })
      setEditType(value.type)
      if (value.type === 'null') setEditValue('')
      else if (value.type === 'blob') {
        const encoded = value.base64 ?? ''
        try {
          setEditValue(base64ToText(encoded))
          setBlobEncoding('text')
        } catch {
          setEditValue(encoded)
          setBlobEncoding('base64')
        }
      } else setEditValue(String(value.value))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load cell')
    }
  }

  const save = async () => {
    if (!editing) return
    setSaving(true)
    setError('')
    try {
      let value: DebugValue
      if (editType === 'null') value = { type: 'null' }
      else if (editType === 'integer') {
        const parsed = Number(editValue)
        if (!Number.isSafeInteger(parsed)) throw new Error('Enter a safe integer')
        value = { type: 'integer', value: parsed }
      } else if (editType === 'real') {
        const parsed = Number(editValue)
        if (!Number.isFinite(parsed)) throw new Error('Enter a valid number')
        value = { type: 'real', value: parsed }
      } else if (editType === 'blob') {
        const base64 = blobEncoding === 'base64'
          ? editValue.trim()
          : bytesToBase64(new TextEncoder().encode(editValue))
        value = { type: 'blob', size: 0, base64 }
      } else value = { type: 'text', value: editValue }
      await api.saveDebugCell(table, editing.rowid, editing.column, value)
      setEditing(null)
      await loadRows()
      onChanged()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not update cell')
    } finally {
      setSaving(false)
    }
  }

  const compact = async () => {
    setConfirmCompact(false)
    setCompacting(true)
    setCompactResult('')
    setError('')
    try {
      const result = await api.compactDatabase()
      setCompactResult(
        result.reclaimed_bytes > 0
          ? `Compaction reclaimed ${formatBytes(result.reclaimed_bytes)}.`
          : 'Compaction completed. SQLite had no disk space to reclaim.',
      )
      await Promise.all([loadDatabase(), loadRows()])
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not compact database')
    } finally {
      setCompacting(false)
    }
  }

  return (
    <>
      <Modal title="Database inspector" onClose={onClose} wide footer={
        <button className="button primary" onClick={onClose}>Done</button>
      }>
        <div className="debug-warning">
          Direct edits affect the live file manager immediately. SQLite constraints still apply.
        </div>
        {database && <section className="database-stats" aria-label="Database storage">
          <div><HardDrive size={18} /><span>Database file<strong>{formatBytes(database.stats.database_bytes)}</strong></span></div>
          <div><Database size={18} /><span>WAL file<strong>{formatBytes(database.stats.wal_bytes)}</strong></span></div>
          <div><Minimize2 size={18} /><span>Reclaimable<strong>{formatBytes(database.stats.reclaimable_bytes)}</strong></span></div>
          <button className="button secondary" disabled={compacting} onClick={() => setConfirmCompact(true)}>
            <Minimize2 size={16} />{compacting ? 'Compacting…' : 'Compact database'}
          </button>
        </section>}
        {compactResult && <div className="alert success" role="status">{compactResult}</div>}
        <div className="database-toolbar">
          <label>
            <span>Table</span>
            <select value={table} onChange={(event) => { setTable(event.target.value); setOffset(0) }}>
              {database?.tables.map((item) => <option key={item.name}>{item.name}</option>)}
            </select>
          </label>
          <button className="icon-button" aria-label="Refresh table" onClick={() => void loadRows()}><RefreshCw size={18} /></button>
          <span>{rows?.total ?? 0} rows</span>
        </div>
        {schema && <div className="schema-summary">
          <Database size={16} />
          {schema.columns.map((column) => (
            <span key={column.name} title={`${column.data_type || 'untyped'}${column.nullable ? ', nullable' : ''}`}>
              {column.name}{column.primary_key ? ' 🔑' : ''}
            </span>
          ))}
        </div>}
        {error && <div className="alert error" role="alert">{error}</div>}
        {loading ? <div className="empty-state compact"><div className="spinner" />Loading table…</div> :
          rows && <div className="database-grid-wrap">
            <table className="database-grid">
              <thead><tr><th>rowid</th>{rows.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
              <tbody>{rows.rows.map((row) => (
                <tr key={row.rowid}>
                  <td>{row.rowid}</td>
                  {row.cells.map((cell, index) => (
                    <td key={rows.columns[index]}>
                      <button title="Edit cell" onClick={() => void edit(row.rowid, rows.columns[index], cell)}>
                        {summarize(cell)}
                      </button>
                    </td>
                  ))}
                </tr>
              ))}</tbody>
            </table>
          </div>}
        <div className="database-pagination">
          <button className="button secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}><ChevronLeft size={16} />Previous</button>
          <span>{rows?.total ? `${offset + 1}–${Math.min(offset + 50, rows.total)} of ${rows.total}` : 'No rows'}</span>
          <button className="button secondary" disabled={!rows || offset + 50 >= rows.total} onClick={() => setOffset(offset + 50)}>Next<ChevronRight size={16} /></button>
        </div>
      </Modal>
      {editing && <Modal title={`Edit ${table}.${editing.column} (row ${editing.rowid})`} onClose={() => setEditing(null)} footer={
        <>
          <button className="button secondary" onClick={() => setEditing(null)}>Cancel</button>
          <button className="button primary" disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Update cell'}</button>
        </>
      }>
        <label className="field">
          <span>SQLite value type</span>
          <select value={editType} onChange={(event) => setEditType(event.target.value as ValueType)}>
            <option value="null">NULL</option>
            <option value="integer">Integer</option>
            <option value="real">Real</option>
            <option value="text">Text</option>
            <option value="blob">BLOB</option>
          </select>
        </label>
        {editType === 'blob' && <label className="field">
          <span>BLOB editor format</span>
          <select value={blobEncoding} onChange={(event) => setBlobEncoding(event.target.value as 'text' | 'base64')}>
            <option value="text">UTF-8 text</option>
            <option value="base64">Base64</option>
          </select>
        </label>}
        {editType !== 'null' && <label className="field">
          <span>Value</span>
          <textarea className="database-cell-editor" value={editValue} onChange={(event) => setEditValue(event.target.value)} spellCheck={false} />
        </label>}
      </Modal>}
      {confirmCompact && <Modal title="Compact database?" onClose={() => setConfirmCompact(false)} footer={
        <>
          <button className="button secondary" onClick={() => setConfirmCompact(false)}>Cancel</button>
          <button className="button danger" onClick={() => void compact()}>Compact database</button>
        </>
      }>
        <p>This checkpoints the WAL and rewrites the entire SQLite database to return unused pages to the operating system.</p>
        <p className="danger-text">The operation can take time, temporarily needs additional disk space, and may briefly block file-manager requests. Do not stop the server while it is running.</p>
      </Modal>}
    </>
  )
}
