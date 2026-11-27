import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Pencil, Plus, Server, Trash2, X } from 'lucide-react'
import type { TaskServer } from '@shared/task-model'
import type { TaskWorkspace } from '../hooks/use-task-workspace'

type Screen = { mode: 'list' } | { mode: 'add' } | { mode: 'edit' | 'remove'; server: TaskServer }
const fieldClass = 'mt-1 block w-full rounded-md border border-hairline bg-surface px-2.5 py-1.5 text-sm text-primary'

export default function TaskServersDialog({ workspace, onClose }: { workspace: TaskWorkspace; onClose: () => void }) {
  const { t } = useTranslation()
  const [screen, setScreen] = useState<Screen>(workspace.sources.length ? { mode: 'list' } : { mode: 'add' })
  const server = screen.mode === 'edit' || screen.mode === 'remove' ? screen.server : undefined
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const focus = useRef<HTMLInputElement>(null)
  const mode = screen.mode
  useEffect(() => { focus.current?.focus() }, [mode])

  function open(next: Screen) {
    const current = 'server' in next ? next.server : undefined
    setName(current?.name ?? '')
    setUrl(current?.serverUrl ?? '')
    setUsername(current?.username ?? '')
    setPassword('')
    setError('')
    setScreen(next)
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting || workspace.busy) return
    setSubmitting(true)
    setError('')
    try {
      if (screen.mode === 'remove') await workspace.removeServer(screen.server.id)
      else if (screen.mode !== 'list') await workspace.saveServer({
        id: server?.id, name, serverUrl: url, username, password
      })
      onClose()
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
      setSubmitting(false)
    }
  }

  const needsPassword = !server || url.trim() !== server.serverUrl || username.trim() !== server.username
  const title = t(mode === 'add' ? 'tasks.addAccount' : mode === 'edit' ? 'tasks.editServer' : mode === 'remove' ? 'tasks.removeServer' : 'tasks.servers')
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/20 p-4" onMouseDown={(event) => {
      if (event.currentTarget === event.target && !submitting) onClose()
    }}>
      <form role="dialog" aria-modal="true" aria-label={title} className="w-full max-w-md rounded-xl border border-hairline bg-dialog p-5 shadow-xl"
        onSubmit={(event) => void submit(event)} onKeyDown={(event) => {
          if (event.key === 'Escape' && !submitting) {
            event.stopPropagation()
            onClose()
          }
        }}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold text-primary">{title}</h2>
          <button type="button" aria-label={t('common.close')} className="gc-icon-btn" onClick={onClose} disabled={submitting}>
            <X className="h-4 w-4" />
          </button>
        </div>
        {mode === 'list' ? (
          <>
            <ul className="max-h-64 divide-y divide-hairline overflow-y-auto">
              {workspace.sources.map((item) => (
                <li key={item.id} className="flex items-center gap-2 py-2">
                  <Server className="h-4 w-4 shrink-0 text-muted" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-primary">{item.name}</p>
                    <p className="truncate text-xs text-muted">{item.serverUrl}</p>
                  </div>
                  <button type="button" className="gc-icon-btn" aria-label={t('tasks.editServerNamed', { name: item.name })} onClick={() => open({ mode: 'edit', server: item })}>
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button type="button" className="gc-icon-btn" aria-label={t('tasks.removeServerNamed', { name: item.name })} onClick={() => open({ mode: 'remove', server: item })}>
                    <Trash2 className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
            <button type="button" className="gc-btn-primary mt-3" onClick={() => open({ mode: 'add' })}><Plus className="h-4 w-4" />{t('tasks.addAccount')}</button>
          </>
        ) : (
          <>
            {mode === 'remove' ? (
              <p className="text-sm text-primary">{t('tasks.removeServerConfirm', { name: server?.name })}</p>
            ) : (
              <div className="grid gap-3 text-sm text-primary">
                <label>{t('tasks.serverName')}<input ref={focus} className={fieldClass} value={name} disabled={submitting} onChange={(event) => setName(event.target.value)} /></label>
                <label>{t('tasks.serverUrl')}<input required className={fieldClass} value={url} disabled={submitting} onChange={(event) => setUrl(event.target.value)} /></label>
                <label>{t('tasks.serverUser')}<input required className={fieldClass} value={username} disabled={submitting} onChange={(event) => setUsername(event.target.value)} /></label>
                <label>{t('tasks.serverPassword')}<input required={needsPassword} type="password" autoComplete="new-password" className={fieldClass}
                  value={password} disabled={submitting} onChange={(event) => setPassword(event.target.value)}
                  placeholder={!needsPassword ? t('tasks.keepPassword') : undefined} /></label>
              </div>
            )}
            {error && <p role="alert" className="mt-2 break-words text-sm text-today">{error}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="gc-btn" disabled={submitting}
                onClick={() => workspace.sources.length ? open({ mode: 'list' }) : onClose()}>{t('common.cancel')}</button>
              <button type="submit" disabled={submitting || workspace.busy} className={mode === 'remove' ? 'gc-btn text-today' : 'gc-btn-primary'}>
                {t(mode === 'remove' ? 'tasks.removeServer' : 'tasks.saveServer')}
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  )
}
