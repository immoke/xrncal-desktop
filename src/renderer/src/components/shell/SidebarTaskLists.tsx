import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Inbox, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react'
import type { CalDavTaskList, CalDavTaskListChange } from '@shared/task-model'
import type { TaskWorkspace } from '../../hooks/use-task-workspace'
import { ContextMenu } from '../ui'

const defaultColor = '#4A7CF0'
type Editor = { action: 'create' } | { action: 'update' | 'delete'; list: CalDavTaskList }

export function SidebarTaskLists({ workspace }: { workspace: TaskWorkspace }) {
  const { t } = useTranslation()
  const [menu, setMenu] = useState<{ x: number; y: number; list: CalDavTaskList } | null>(null)
  const [editor, setEditor] = useState<Editor | null>(null)

  function openMenu(event: MouseEvent<HTMLButtonElement>, list: CalDavTaskList) {
    const rect = event.currentTarget.getBoundingClientRect()
    setMenu({ x: rect.left, y: rect.bottom + 3, list })
  }

  return (
    <section aria-label={t('tasks.list')}>
      <div className="mb-1 flex items-center justify-between px-1.5">
        <h2 className="text-xs font-semibold text-secondary">{t('tasks.list')}</h2>
        <button type="button" className="gc-icon-btn h-6 w-6" aria-label={t('tasks.createList')} title={t('tasks.createList')}
          disabled={!workspace.account || workspace.busy} onClick={() => setEditor({ action: 'create' })}>
          <Plus className="h-4 w-4" />
        </button>
      </div>
      {workspace.sources.length > 1 && (
        <select className="mb-2 w-full rounded-md border border-hairline bg-surface px-2 py-1.5 text-xs text-primary"
          aria-label={t('tasks.account')} value={workspace.account?.id ?? ''} disabled={workspace.saving}
          onChange={(event) => workspace.selectServer(event.target.value)}>
          {workspace.sources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}
        </select>
      )}
      <button type="button" className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-primary hover:bg-hover ${!workspace.selectedList ? 'bg-hover' : ''}`}
        aria-pressed={!workspace.selectedList} onClick={() => workspace.selectList('')}>
        <Inbox className="h-3.5 w-3.5 shrink-0 text-muted" />
        <span className="truncate">{t('tasks.allLists')}</span>
      </button>
      {workspace.lists.map((list) => {
        const name = list.name || t('tasks.inbox')
        return (
          <div key={list.id} className={`group flex items-center gap-1 rounded-md hover:bg-hover ${workspace.selectedList?.id === list.id ? 'bg-hover' : ''}`}>
            <button type="button" className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm text-primary"
              aria-pressed={workspace.selectedList?.id === list.id} onClick={() => workspace.selectList(list.id)} title={name}>
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: list.color ?? defaultColor }} />
              <span className="truncate">{name}</span>
            </button>
            {list.canEdit && (
              <button type="button" className="gc-icon-btn mr-1 h-6 w-6 shrink-0 text-muted" aria-label={t('tasks.listOptions', { name })}
                disabled={workspace.busy} onClick={(event) => openMenu(event, list)}>
                <MoreHorizontal className="h-4 w-4" />
              </button>
            )}
          </div>
        )
      })}
      <ContextMenu at={menu} onClose={() => setMenu(null)} entries={menu ? [
        { label: t('tasks.editList'), icon: <Pencil className="h-3.5 w-3.5" />, onSelect: () => setEditor({ action: 'update', list: menu.list }) },
        { label: t('tasks.deleteList'), icon: <Trash2 className="h-3.5 w-3.5" />, danger: true, disabled: !menu.list.canDelete, onSelect: () => setEditor({ action: 'delete', list: menu.list }) }
      ] : []} />
      {editor && <TaskListEditor editor={editor} server={workspace.account?.name ?? ''} onSave={workspace.changeList} onClose={() => setEditor(null)} />}
    </section>
  )
}

function TaskListEditor({ editor, server, onSave, onClose }: {
  editor: Editor
  server: string
  onSave: (change: CalDavTaskListChange) => Promise<void>
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState(editor.action === 'create' ? '' : editor.list.name || t('tasks.inbox'))
  const [color, setColor] = useState(editor.action === 'create' ? defaultColor : editor.list.color ?? defaultColor)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const focusRef = useRef<HTMLInputElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const action = editor.action
  useEffect(() => { (action === 'delete' ? cancelRef.current : focusRef.current)?.focus() }, [action])

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving || (editor.action !== 'delete' && !name.trim())) return
    setSaving(true)
    setError('')
    try {
      const details = { name: name.trim(), color }
      if (editor.action === 'create') await onSave({ action: 'create', details })
      else if (editor.action === 'update') await onSave({ action: 'update', id: editor.list.id, details })
      else await onSave({ action: 'delete', id: editor.list.id })
      onClose()
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
      setSaving(false)
    }
  }

  const title = t(action === 'create' ? 'tasks.createList' : action === 'update' ? 'tasks.editList' : 'tasks.deleteList')
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/20 p-4" onMouseDown={(event) => {
      if (event.currentTarget === event.target && !saving) onClose()
    }}>
      <form className="w-full max-w-sm rounded-xl border border-hairline bg-dialog p-5 shadow-xl"
        role="dialog" aria-modal="true" aria-label={title} onSubmit={(event) => void save(event)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !saving) {
            event.stopPropagation()
            onClose()
          }
        }}>
        <h2 className="mb-2 text-base font-semibold text-primary">{title}</h2>
        {server && <p className="mb-3 truncate text-xs text-muted">{server}</p>}
        {action === 'delete' ? (
          <p className="text-sm text-primary">{t('tasks.deleteConfirm', { name })}</p>
        ) : (
          <div className="flex items-end gap-3">
            <label className="min-w-0 flex-1 text-sm text-primary">
              <span className="mb-1.5 block">{t('tasks.listName')}</span>
              <input ref={focusRef} className="w-full rounded-md border border-hairline bg-surface px-2.5 py-1.5 text-sm text-primary"
                maxLength={120} value={name} disabled={saving} onChange={(event) => setName(event.target.value)} />
            </label>
            <label className="text-sm text-primary">
              <span className="mb-1.5 block">{t('tasks.listColor')}</span>
              <input type="color" className="h-8 w-12 rounded-md border border-hairline bg-surface p-1"
                value={color} disabled={saving} onChange={(event) => setColor(event.target.value)} />
            </label>
          </div>
        )}
        {error && <p role="alert" className="mt-3 break-words text-sm text-today">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" ref={cancelRef} className="gc-btn" disabled={saving} onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" className={action === 'delete' ? 'gc-btn text-today' : 'gc-btn-primary'}
            disabled={saving || (action !== 'delete' && !name.trim())}>
            {t(action === 'delete' ? 'common.delete' : 'tasks.saveList')}
          </button>
        </div>
      </form>
    </div>
  )
}
