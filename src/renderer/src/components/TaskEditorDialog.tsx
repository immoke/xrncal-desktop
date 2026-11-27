import { useState, type FormEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { AlignLeft, Bell, Clock, Inbox, Minus, Plus, Type, X, type LucideIcon } from 'lucide-react'
import { TIMED_REMINDER_PRESETS } from '@shared/reminders'
import {
  MAX_TASK_DESCRIPTION_LENGTH, MAX_TASK_REMINDERS, MAX_TASK_TITLE_LENGTH,
  type CalDavTask, type CalDavTaskList, type CreateTaskInput, type TaskDetails, type UpdateTaskInput
} from '@shared/task-model'
import { useDisplayPreferences } from '../context/DisplayPreferencesContext'
import { useDialogFocus } from '../hooks/use-dialog-focus'
import { reminderLabel } from '../lib/reminder-labels'

const fieldClass = 'gc-input w-full min-w-0 px-2.5 py-1.5 scheme-light dark:scheme-dark'

interface CategoryChoices {
  lists: CalDavTaskList[]
  defaultListId: string
}

type TaskEditorDialogProps = {
  onClose: () => void
} & (
  | (CategoryChoices & { mode: 'create'; defaultDueDate: string; onSave: (input: CreateTaskInput) => Promise<void> })
  | (CategoryChoices & { mode: 'edit'; task: CalDavTask; onSave: (input: UpdateTaskInput) => Promise<void> })
  | { mode: 'delete'; task: CalDavTask; onSave: () => Promise<void> }
)

export function TaskEditorDialog(props: TaskEditorDialogProps) {
  const { t } = useTranslation()
  const { timeFormat } = useDisplayPreferences()
  const { ref: formRef, onKeyDown: trapTab } = useDialogFocus<HTMLFormElement>()
  const [requestId] = useState(() => crypto.randomUUID())
  const [title, setTitle] = useState(props.mode === 'create' ? '' : props.task.title)
  const [listId, setListId] = useState(props.mode === 'delete' ? '' : props.defaultListId)
  const [dueDate, setDueDate] = useState(props.mode === 'create' ? props.defaultDueDate : props.task.dueDate ?? '')
  const [dueTime, setDueTime] = useState(props.mode === 'create' ? '' : props.task.dueTime ?? '')
  const [description, setDescription] = useState(props.mode === 'create' ? '' : props.task.description ?? '')
  const [reminders, setReminders] = useState(props.mode === 'create' ? [] : props.task.reminderMinutes ?? [])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const deleting = props.mode === 'delete'
  const heading = t(props.mode === 'create' ? 'tasks.createTask' : deleting ? 'tasks.deleteTask' : 'tasks.editTask')
  const canSave = !submitting && (deleting || (title.trim() && (dueDate || reminders.length === 0) &&
    props.lists.some((list) => list.id === listId)))
  const onClose = props.onClose
  const nextReminder = TIMED_REMINDER_PRESETS.find((minutes) => !reminders.includes(minutes))

  function changeDate(date: string) {
    setDueDate(date)
    if (!date) setDueTime('')
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canSave) return
    setSubmitting(true)
    setError('')
    try {
      const details: TaskDetails = {
        title: title.trim(), dueDate: dueDate || undefined, dueTime: dueTime || null
      }
      if (props.mode === 'delete') await props.onSave()
      else if (props.mode === 'edit') {
        if (description !== (props.task.description ?? '')) details.description = description
        const previous = props.task.reminderMinutes ?? []
        const minutes = [...reminders].sort((a, b) => a - b)
        if (previous.join() !== minutes.join()) details.reminderMinutes = minutes
        await props.onSave({ ...details, listId })
      } else await props.onSave({ requestId, listId, ...details, description, reminderMinutes: reminders })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setError(message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, ''))
      setSubmitting(false)
    }
  }

  return (
    <div className="gc-overlay" onMouseDown={(event) => {
      if (event.currentTarget === event.target && !submitting) onClose()
    }}>
      <form ref={formRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={heading}
        className={`gc-dialog w-full ${deleting ? 'max-w-sm' : 'max-w-[30rem]'}`}
        onSubmit={(event) => void submit(event)} onKeyDown={(event) => {
          trapTab(event)
          if (event.key === 'Escape' && !submitting) {
            event.preventDefault()
            event.stopPropagation()
            onClose()
          }
        }}>
        <header className="flex shrink-0 items-center justify-between border-b border-hairline px-5">
          <h2 className="border-b-2 border-accent py-3 text-sm font-semibold">{heading}</h2>
          <button type="button" className="gc-icon-btn ml-3" aria-label={t('common.close')} disabled={submitting} onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="overflow-y-auto px-5 py-4">
          {deleting ? <p className="text-sm">{t('tasks.deleteTaskConfirm', { name: title || t('tasks.untitled') })}</p> : (
            <div className="grid gap-2.5">
              <TaskField icon={Type}>
                <input className={`${fieldClass} font-medium`} required autoFocus maxLength={MAX_TASK_TITLE_LENGTH}
                  aria-label={t('tasks.taskTitle')} placeholder={t('tasks.titlePlaceholder')}
                  value={title} disabled={submitting} onChange={(event) => setTitle(event.target.value)} />
              </TaskField>
              <TaskField icon={Clock}>
                <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] gap-2">
                  <input type="date" className={fieldClass} aria-label={t('tasks.taskDueDate')} value={dueDate}
                    disabled={submitting} onChange={(event) => changeDate(event.target.value)} />
                  <input type="time" className={fieldClass} aria-label={t('tasks.taskDueTime')} value={dueTime}
                    disabled={submitting || !dueDate} onChange={(event) => setDueTime(event.target.value)} />
                </div>
              </TaskField>
              <TaskField icon={Inbox}>
                <select className={fieldClass} aria-label={t('tasks.taskCategory')} value={listId}
                  disabled={submitting} onChange={(event) => setListId(event.target.value)}>
                  {props.lists.map((list) => <option key={list.id} value={list.id}>{list.name || t('tasks.inbox')}</option>)}
                </select>
              </TaskField>
              <TaskField icon={AlignLeft}>
                <textarea className={`${fieldClass} resize-y`} rows={2} maxLength={MAX_TASK_DESCRIPTION_LENGTH}
                  aria-label={t('tasks.taskDescription')} placeholder={t('tasks.descriptionPlaceholder')}
                  value={description} disabled={submitting} onChange={(event) => setDescription(event.target.value)} />
              </TaskField>
              <TaskField icon={Bell}>
                <div className="grid gap-2">
                  {reminders.map((minutes, index) => (
                    <div key={minutes} className="flex items-center gap-2">
                      <select className={fieldClass} aria-label={`${t('reminders.label')} ${index + 1}`} value={minutes} disabled={submitting}
                        onChange={(event) => {
                          const next = Number(event.target.value)
                          setReminders((current) => current.map((value) => value === minutes ? next : value))
                        }}>
                        {[...new Set([...TIMED_REMINDER_PRESETS, minutes])].sort((a, b) => a - b).map((preset) => (
                          <option key={preset} value={preset} disabled={preset !== minutes && reminders.includes(preset)}>
                            {preset === 0 ? t('tasks.atDue') : reminderLabel(t, { minutesBefore: preset }, false, timeFormat)}
                          </option>
                        ))}
                      </select>
                      <button type="button" className="gc-icon-btn border border-hairline"
                        aria-label={t('tasks.removeReminder', { number: index + 1 })} disabled={submitting}
                        onClick={() => setReminders((current) => current.filter((value) => value !== minutes))}>
                        <Minus className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <button type="button" className="gc-btn" disabled={submitting || !dueDate || reminders.length >= MAX_TASK_REMINDERS || nextReminder === undefined}
                      onClick={() => { if (nextReminder !== undefined) setReminders((current) => [...current, nextReminder]) }}>
                      <Plus className="h-4 w-4" />
                      {t('reminders.add')}
                    </button>
                    {!dueDate && <span className="text-xs text-muted">{t('tasks.reminderNeedsDue')}</span>}
                  </div>
                </div>
              </TaskField>
            </div>
          )}
          {error && <p role="alert" className="mt-3 break-words text-sm text-today">{error}</p>}
        </div>
        <footer className="flex shrink-0 justify-end gap-2 border-t border-hairline bg-surface/60 px-5 py-3">
          <button type="button" className="gc-btn" autoFocus={deleting} disabled={submitting} onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" className={deleting ? 'gc-btn text-today' : 'gc-btn-primary min-w-24'} disabled={!canSave}>
            {t(deleting ? 'common.delete' : 'tasks.saveTask')}
          </button>
        </footer>
      </form>
    </div>
  )
}

function TaskField({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[1.25rem_minmax(0,1fr)] items-start gap-2.5">
      <Icon className="mt-2 h-4 w-4 text-muted" aria-hidden="true" />
      {children}
    </div>
  )
}
