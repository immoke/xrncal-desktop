import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { MAX_TASK_TITLE_LENGTH, type CalDavTask, type CalDavTaskList, type CreateTaskInput, type TaskDetails } from '@shared/task-model'

const fieldClass = 'mt-1 block w-full rounded-md border border-hairline bg-surface px-2.5 py-1.5 text-sm text-primary'

type TaskEditorDialogProps = {
  onClose: () => void
} & (
  | { mode: 'create'; lists: CalDavTaskList[]; defaultListId: string; defaultDueDate: string; onSave: (input: CreateTaskInput) => Promise<void> }
  | { mode: 'edit'; task: CalDavTask; onSave: (input: TaskDetails) => Promise<void> }
  | { mode: 'delete'; task: CalDavTask; onSave: () => Promise<void> }
)

export function TaskEditorDialog(props: TaskEditorDialogProps) {
  const { t } = useTranslation()
  const [requestId] = useState(() => crypto.randomUUID())
  const [title, setTitle] = useState(props.mode === 'create' ? '' : props.task.title)
  const [listId, setListId] = useState(props.mode === 'create' ? props.defaultListId : '')
  const [dueDate, setDueDate] = useState(props.mode === 'create' ? props.defaultDueDate : props.task.dueDate ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const deleting = props.mode === 'delete'
  const heading = t(props.mode === 'create' ? 'tasks.createTask' : deleting ? 'tasks.deleteTask' : 'tasks.editTask')
  const canSave = !submitting && (deleting || (title.trim() &&
    (props.mode !== 'create' || props.lists.some((list) => list.id === listId))))
  const onClose = props.onClose

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canSave) return
    setSubmitting(true)
    setError('')
    try {
      const details = { title: title.trim(), dueDate: dueDate || undefined }
      if (props.mode === 'delete') await props.onSave()
      else if (props.mode === 'edit') await props.onSave(details)
      else await props.onSave({ requestId, listId, ...details })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setError(message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, ''))
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/20 p-4" onMouseDown={(event) => {
      if (event.currentTarget === event.target && !submitting) onClose()
    }}>
      <form role="dialog" aria-modal="true" aria-label={heading} className="w-full max-w-sm rounded-xl border border-hairline bg-dialog p-5 shadow-xl"
        onSubmit={(event) => void submit(event)} onKeyDown={(event) => {
          if (event.key === 'Escape' && !submitting) {
            event.stopPropagation()
            onClose()
          }
        }}>
        <h2 className="mb-3 text-base font-semibold text-primary">{heading}</h2>
        {deleting ? <p className="text-sm text-primary">
          {t('tasks.deleteTaskConfirm', { name: title || t('tasks.untitled') })}
        </p> : <div className="grid gap-3 text-sm text-primary">
          <label>{t('tasks.taskTitle')}
            <input className={fieldClass} required autoFocus maxLength={MAX_TASK_TITLE_LENGTH}
              value={title} disabled={submitting} onChange={(event) => setTitle(event.target.value)} />
          </label>
          {props.mode === 'create' && <label>{t('tasks.taskCategory')}
            <select className={fieldClass} value={listId} disabled={submitting} onChange={(event) => setListId(event.target.value)}>
              {props.lists.map((list) => <option key={list.id} value={list.id}>{list.name || t('tasks.inbox')}</option>)}
            </select>
          </label>}
          <label>{t('tasks.taskDueDate')}
            <input type="date" className={fieldClass} value={dueDate} disabled={submitting}
              onChange={(event) => setDueDate(event.target.value)} />
          </label>
        </div>}
        {error && <p role="alert" className="mt-3 break-words text-sm text-today">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="gc-btn" autoFocus={deleting} disabled={submitting} onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" className={deleting ? 'gc-btn text-today' : 'gc-btn-primary'} disabled={!canSave}>
            {t(deleting ? 'common.delete' : 'tasks.saveTask')}
          </button>
        </div>
      </form>
    </div>
  )
}
