import React from 'react'
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react'
import { useApp } from '@/store/appStore'
import { Progress, Spinner } from './ui/ui'

export function Toasts(): React.JSX.Element {
  const toasts = useApp((s) => s.toasts)
  const dismiss = useApp((s) => s.dismissToast)
  return (
    <div className="fixed bottom-4 right-4 z-[200] flex flex-col gap-2 w-[340px] pointer-events-none">
      {toasts.map((t) => (
        <div key={t.id} className="card pointer-events-auto p-3 flex gap-3 fade-in" style={{ boxShadow: 'var(--shadow-pop)' }}>
          <div className="shrink-0 mt-0.5">
            {t.kind === 'success' && <CheckCircle2 size={16} className="text-ok" />}
            {t.kind === 'error' && <AlertCircle size={16} className="text-danger" />}
            {t.kind === 'info' && <Info size={16} className="text-accent-2" />}
            {t.kind === 'progress' && <Spinner size={16} className="text-accent-2" />}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[12.5px] font-semibold truncate">{t.title}</div>
            {t.message && <div className="text-[12px] text-fg-2 mt-0.5 break-words">{t.message}</div>}
            {t.kind === 'progress' && <Progress value={t.progress ?? 0} className="mt-2" />}
            {t.action && (
              <button className="btn btn-sm mt-2" onClick={t.action.onClick}>
                {t.action.label}
              </button>
            )}
          </div>
          <button className="text-fg-3 hover:text-fg shrink-0" onClick={() => dismiss(t.id)} aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}
