import { useEffect, useRef, useState, type ReactNode } from 'react'

export function Button({ children, variant = 'primary', ...props }: { children: ReactNode; variant?: 'primary' | 'secondary' | 'ghost'; onClick?: () => void }) {
  return <button className={`button button-${variant}`} {...props}>{children}</button>
}

export function Card({ children }: { children: ReactNode }) { return <div className="ui-card">{children}</div> }

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'success' | 'warning' | 'danger' }) {
  return <span className={`badge badge-${tone}`}><span className="badge-dot" />{children}</span>
}

export function Skeleton({ width = '100%' }: { width?: string }) { return <div className="skeleton" style={{ width }} aria-hidden="true" /> }

export function Toast({ children }: { children: ReactNode }) { return <div className="toast" role="status"><span>✓</span>{children}</div> }

export function Tabs({ items }: { items: string[] }) {
  const [active, setActive] = useState(items[0] ?? '')
  return <div className="tabs" role="tablist">{items.map((item) => <button key={item} role="tab" aria-selected={active === item} className={active === item ? 'tab active' : 'tab'} onClick={() => setActive(item)}>{item}</button>)}</div>
}

export function Modal({ open, title, children, onClose }: { open: boolean; title: string; children: ReactNode; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (open) closeRef.current?.focus() }, [open])
  if (!open) return null
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><button ref={closeRef} className="modal-close" onClick={onClose} aria-label="Close dialog">×</button><h2 id="modal-title">{title}</h2><div>{children}</div></section></div>
}
