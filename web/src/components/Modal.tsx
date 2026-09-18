import { X } from 'lucide-react'
import { type FormEvent, type ReactNode, useEffect, useRef } from 'react'

interface ModalProps {
  title: string
  children: ReactNode
  onClose: () => void
  footer?: ReactNode
  wide?: boolean
}

export function Modal({ title, children, onClose, footer, wide }: ModalProps) {
  const dialog = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const current = dialog.current
    current?.showModal()
    return () => current?.close()
  }, [])

  const preventDefault = (event: FormEvent) => event.preventDefault()
  return (
    <dialog ref={dialog} className={`modal ${wide ? 'modal-wide' : ''}`} onCancel={onClose}>
      <form method="dialog" onSubmit={preventDefault}>
        <header>
          <h2>{title}</h2>
          <button className="icon-button" aria-label="Close dialog" onClick={onClose}>
            <X size={20} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </form>
    </dialog>
  )
}

interface PromptProps {
  title: string
  label: string
  value: string
  confirmLabel?: string
  onConfirm: (value: string) => void
  onClose: () => void
}

export function PromptDialog({ title, label, value, confirmLabel = 'Save', onConfirm, onClose }: PromptProps) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="button secondary" onClick={onClose}>Cancel</button>
          <button className="button primary" onClick={() => {
            const next = input.current?.value.trim()
            if (next) onConfirm(next)
          }}>{confirmLabel}</button>
        </>
      }
    >
      <label className="field">
        <span>{label}</span>
        <input ref={input} defaultValue={value} autoFocus onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            const next = input.current?.value.trim()
            if (next) onConfirm(next)
          }
        }} />
      </label>
    </Modal>
  )
}

interface ConfirmProps {
  title: string
  children: ReactNode
  confirmLabel: string
  danger?: boolean
  onConfirm: () => void
  onClose: () => void
}

export function ConfirmDialog({ title, children, confirmLabel, danger, onConfirm, onClose }: ConfirmProps) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="button secondary" onClick={onClose}>Cancel</button>
          <button className={`button ${danger ? 'danger' : 'primary'}`} onClick={onConfirm}>{confirmLabel}</button>
        </>
      }
    >
      {children}
    </Modal>
  )
}
