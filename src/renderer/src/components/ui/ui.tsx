import React, { useEffect, useId, useRef, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { cn, clamp } from '@/lib/utils'

// ── Slider ──────────────────────────────────────────────────────────────────

export function Slider({
  label,
  value,
  min,
  max,
  step = 0.01,
  onChange,
  onCommit,
  format,
  disabled,
  className
}: {
  label?: string
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
  onCommit?: (v: number) => void
  format?: (v: number) => string
  disabled?: boolean
  className?: string
}): React.JSX.Element {
  const pct = ((clamp(value, min, max) - min) / (max - min)) * 100
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const fmt = format ?? ((v: number) => (Number.isInteger(step) ? String(Math.round(v)) : v.toFixed(2)))
  return (
    <div className={cn('flex flex-col gap-1.5', disabled && 'opacity-50 pointer-events-none', className)}>
      {(label || format) && (
        <div className="flex items-center justify-between">
          {label && <span className="text-[12px] text-fg-2">{label}</span>}
          {editing ? (
            <input
              autoFocus
              className="input h-6 w-16 text-right text-[11.5px] px-1.5"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onBlur={() => {
                const n = parseFloat(text)
                if (!isNaN(n)) {
                  onChange(clamp(n, min, max))
                  onCommit?.(clamp(n, min, max))
                }
                setEditing(false)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                if (e.key === 'Escape') setEditing(false)
              }}
            />
          ) : (
            <button
              className="text-[11.5px] font-mono text-fg-3 hover:text-fg tabular-nums"
              onClick={() => {
                setText(String(Math.round(value * 100) / 100))
                setEditing(true)
              }}
            >
              {fmt(value)}
            </button>
          )}
        </div>
      )}
      <input
        type="range"
        className="slider"
        style={{ ['--pct' as string]: `${pct}%` }}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        onPointerUp={(e) => onCommit?.(parseFloat((e.target as HTMLInputElement).value))}
        onKeyUp={(e) => onCommit?.(parseFloat((e.target as HTMLInputElement).value))}
      />
    </div>
  )
}

// ── Toggle ──────────────────────────────────────────────────────────────────

export function Toggle({ label, checked, onChange, hint, className }: { label?: React.ReactNode; checked: boolean; onChange: (v: boolean) => void; hint?: string; className?: string }): React.JSX.Element {
  return (
    <label className={cn('flex items-center justify-between gap-3 cursor-pointer select-none', className)}>
      {label && (
        <span className="flex flex-col">
          <span className="text-[12.5px]">{label}</span>
          {hint && <span className="text-[11px] text-fg-3">{hint}</span>}
        </span>
      )}
      <button type="button" role="switch" aria-checked={checked} className="switch" data-on={checked} onClick={() => onChange(!checked)} />
    </label>
  )
}

// ── Segmented control ───────────────────────────────────────────────────────

export function Segmented<T extends string>({ value, options, onChange, className, size }: { value: T; options: Array<{ value: T; label: React.ReactNode; title?: string }>; onChange: (v: T) => void; className?: string; size?: 'sm' }): React.JSX.Element {
  return (
    <div className={cn('seg', className)}>
      {options.map((o) => (
        <button key={o.value} type="button" data-active={o.value === value} onClick={() => onChange(o.value)} title={o.title} className={cn(size === 'sm' && '!h-6 !px-2 !text-[11px]', 'flex-1 flex items-center justify-center gap-1')}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

// ── Color ───────────────────────────────────────────────────────────────────

export function ColorField({ label, value, onChange, allowAlpha, className, compact }: { label?: string; value: string; onChange: (v: string) => void; allowAlpha?: boolean; className?: string; compact?: boolean }): React.JSX.Element {
  const hex = toHex(value)
  return (
    <div className={cn('flex items-center justify-between gap-2', className)}>
      {label && <span className="text-[12px] text-fg-2">{label}</span>}
      <div className="flex items-center gap-1.5">
        <label className="relative w-7 h-7 rounded-md overflow-hidden border border-line-2 cursor-pointer checker shrink-0">
          <span className="absolute inset-0" style={{ background: value }} />
          <input type="color" value={hex} onChange={(e) => onChange(e.target.value)} className="absolute inset-0 opacity-0 cursor-pointer" />
        </label>
        {!compact && <input
          className="input h-7 w-[92px] font-mono text-[11px]"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={(e) => {
            const v = e.target.value.trim()
            if (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v) || /^rgba?\(/.test(v) || allowAlpha) onChange(v)
            else onChange(hex)
          }}
        />}
      </div>
    </div>
  )
}

function toHex(c: string): string {
  if (/^#[0-9a-f]{6}$/i.test(c)) return c
  if (/^#[0-9a-f]{3}$/i.test(c)) return '#' + c.slice(1).split('').map((x) => x + x).join('')
  if (/^#[0-9a-f]{8}$/i.test(c)) return c.slice(0, 7)
  const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
  if (m) return '#' + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')
  return '#ffffff'
}

// ── Select ──────────────────────────────────────────────────────────────────

export function Select<T extends string>({ label, value, options, onChange, className }: { label?: string; value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void; className?: string }): React.JSX.Element {
  return (
    <div className={cn('flex items-center justify-between gap-2', className)}>
      {label && <span className="text-[12px] text-fg-2 shrink-0">{label}</span>}
      <div className="relative flex-1 max-w-[190px]">
        <select className="input h-7 pr-6 appearance-none cursor-pointer text-[12px]" value={value} onChange={(e) => onChange(e.target.value as T)}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <ChevronDown size={13} className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-fg-3" />
      </div>
    </div>
  )
}

// ── Section (collapsible) ───────────────────────────────────────────────────

export function Section({ title, children, defaultOpen = true, right, className }: { title: string; children: React.ReactNode; defaultOpen?: boolean; right?: React.ReactNode; className?: string }): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className={cn('border-b border-line', className)}>
      <div className="flex items-center justify-between px-4 h-10 cursor-pointer select-none hover:bg-white/[0.02]" onClick={() => setOpen(!open)}>
        <div className="flex items-center gap-1.5">
          <ChevronRight size={13} className={cn('text-fg-3 transition-transform', open && 'rotate-90')} />
          <span className="text-[12px] font-semibold">{title}</span>
        </div>
        <div onClick={(e) => e.stopPropagation()}>{right}</div>
      </div>
      {open && <div className="px-4 pb-4 flex flex-col gap-3 fade-in">{children}</div>}
    </div>
  )
}

// ── Field row ───────────────────────────────────────────────────────────────

export function Row({ label, children, className }: { label: React.ReactNode; children: React.ReactNode; className?: string }): React.JSX.Element {
  return (
    <div className={cn('flex items-center justify-between gap-3', className)}>
      <span className="text-[12px] text-fg-2 shrink-0">{label}</span>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  )
}

// ── Number input ────────────────────────────────────────────────────────────

export function NumberField({ value, onChange, min, max, step = 1, suffix, className, width = 72 }: { value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; suffix?: string; className?: string; width?: number }): React.JSX.Element {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(Math.round(value * 100) / 100)), [value])
  const commit = (): void => {
    let n = parseFloat(text)
    if (isNaN(n)) n = value
    if (min != null) n = Math.max(min, n)
    if (max != null) n = Math.min(max, n)
    onChange(n)
    setText(String(Math.round(n * 100) / 100))
  }
  return (
    <div className={cn('relative', className)} style={{ width }}>
      <input
        className="input h-7 pr-6 text-[12px] font-mono"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'ArrowUp') {
            e.preventDefault()
            onChange(Math.min(max ?? Infinity, value + step))
          }
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            onChange(Math.max(min ?? -Infinity, value - step))
          }
        }}
      />
      {suffix && <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10.5px] text-fg-3 pointer-events-none">{suffix}</span>}
    </div>
  )
}

// ── Tooltip wrapper ─────────────────────────────────────────────────────────

export function Tip({ label, children, side = 'top' }: { label: React.ReactNode; children: React.ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }): React.JSX.Element {
  const [show, setShow] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pos = side === 'top' ? 'bottom-full mb-1.5 left-1/2 -translate-x-1/2' : side === 'bottom' ? 'top-full mt-1.5 left-1/2 -translate-x-1/2' : side === 'left' ? 'right-full mr-1.5 top-1/2 -translate-y-1/2' : 'left-full ml-1.5 top-1/2 -translate-y-1/2'
  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => (timer.current = setTimeout(() => setShow(true), 350))}
      onMouseLeave={() => {
        if (timer.current) clearTimeout(timer.current)
        setShow(false)
      }}
    >
      {children}
      {show && <span className={cn('tooltip', pos)}>{label}</span>}
    </span>
  )
}

// ── Icon button ─────────────────────────────────────────────────────────────

export function IconButton({ icon, label, onClick, active, danger, className, disabled, size = 'md' }: { icon: React.ReactNode; label: string; onClick?: () => void; active?: boolean; danger?: boolean; className?: string; disabled?: boolean; size?: 'sm' | 'md' }): React.JSX.Element {
  return (
    <Tip label={label}>
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className={cn('btn btn-ghost btn-icon', size === 'sm' && '!h-7 !w-7', active && '!bg-accent-soft !text-accent-2', danger && 'hover:!bg-danger/15 hover:!text-danger', className)}
      >
        {icon}
      </button>
    </Tip>
  )
}

// ── Modal ───────────────────────────────────────────────────────────────────

export function Modal({ open, onClose, title, children, width = 520, footer }: { open: boolean; onClose: () => void; title?: React.ReactNode; children: React.ReactNode; width?: number; footer?: React.ReactNode }): React.JSX.Element | null {
  const id = useId()
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-[2px] fade-in" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-labelledby={id} className="card shadow-pop flex flex-col max-h-[85vh]" style={{ width, boxShadow: 'var(--shadow-pop)' }}>
        {title && (
          <div id={id} className="px-5 h-12 flex items-center justify-between border-b border-line text-[13.5px] font-semibold">
            {title}
          </div>
        )}
        <div className="p-5 overflow-y-auto">{children}</div>
        {footer && <div className="px-5 py-3 border-t border-line flex items-center justify-end gap-2">{footer}</div>}
      </div>
    </div>
  )
}

export function Spinner({ size = 16, className }: { size?: number; className?: string }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={cn('animate-spin', className)}>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" fill="none" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" />
    </svg>
  )
}

export function Progress({ value, className }: { value: number; className?: string }): React.JSX.Element {
  return (
    <div className={cn('h-1.5 w-full rounded-full overflow-hidden bg-white/10', className)}>
      <div className="h-full rounded-full transition-[width] duration-200" style={{ width: `${Math.round(clamp(value, 0, 1) * 100)}%`, background: 'linear-gradient(90deg,#7c5cff,#a78bfa)' }} />
    </div>
  )
}

export function EmptyState({ icon, title, description, action }: { icon: React.ReactNode; title: string; description?: string; action?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center text-center gap-2 py-10 px-4">
      <div className="w-12 h-12 rounded-2xl grid place-items-center bg-white/[0.04] border border-line text-fg-3">{icon}</div>
      <div className="text-[13px] font-semibold mt-1">{title}</div>
      {description && <div className="text-[12px] text-fg-3 max-w-[260px]">{description}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}
