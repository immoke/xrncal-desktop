import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DateTime } from 'luxon'
import { X } from 'lucide-react'
import type { CalDavTask, CalDavTaskList } from '@shared/task-model'
import type { TaskWorkspace } from '../hooks/use-task-workspace'

export default function TasksView({ workspace, dueOn, clearDate, onAddServer }: {
  workspace: TaskWorkspace
  dueOn: string | null
  clearDate: () => void
  onAddServer: () => void
}) {
  const { t, i18n } = useTranslation()
  const [showCompleted, setShowCompleted] = useState(false)
  const [error, setError] = useState<{ message: string; lists: CalDavTaskList[] } | null>(null)

  async function toggle(task: CalDavTask) {
    setError(null)
    try {
      const result = await workspace.toggle(task)
      if (result && result !== 'saved') setError({ message: t(`tasks.${result}`), lists: workspace.lists })
    } catch (error) {
      setError({ message: error instanceof Error ? error.message : String(error), lists: workspace.lists })
    }
  }

  const scoped = (workspace.selectedList ? [workspace.selectedList] : workspace.lists).flatMap((list) =>
    list.tasks.filter((task) => !dueOn || task.dueDate === dueOn)
      .map((task) => ({ task, listName: list.name || t('tasks.inbox'), color: list.color }))
  )
  const completedCount = scoped.filter(({ task }) => task.completed).length
  const shown = scoped.filter(({ task }) => task.completed === showCompleted)
    .sort((a, b) => (a.task.dueDate ?? '9999').localeCompare(b.task.dueDate ?? '9999'))
  const today = DateTime.local().toISODate()
  const dateLabel = (date: string) => DateTime.fromISO(date).setLocale(i18n.language).toLocaleString(DateTime.DATE_MED)
  const feedback = workspace.error || (error?.lists === workspace.lists && error.message)

  return (
    <main className="relative min-h-0 min-w-0 flex-1 overflow-y-auto bg-surface">
      <div className="mx-auto max-w-4xl px-5 py-5 sm:px-7">
        {workspace.account ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline pb-3">
              <div className="flex flex-wrap items-center gap-1">
                <button type="button" className={`rounded-md px-3 py-1.5 text-sm ${!showCompleted ? 'bg-hover text-accent' : 'text-secondary hover:bg-hover'}`} aria-pressed={!showCompleted} onClick={() => setShowCompleted(false)}>
                  {t('tasks.pending')} <span className="ml-1 tabular-nums text-secondary">{scoped.length - completedCount}</span>
                </button>
                <button type="button" className={`rounded-md px-3 py-1.5 text-sm ${showCompleted ? 'bg-hover text-accent' : 'text-secondary hover:bg-hover'}`} aria-pressed={showCompleted} onClick={() => setShowCompleted(true)}>
                  {t('tasks.completed')} <span className="ml-1 tabular-nums text-secondary">{completedCount}</span>
                </button>
              </div>
              {dueOn && (
                <button type="button" className="gc-btn" onClick={clearDate} title={t('tasks.clearDate')} aria-label={t('tasks.clearDate')}>
                  {dateLabel(dueOn)} <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            {feedback && <p role="alert" className="my-3 rounded-md border border-hairline px-3 py-2 text-sm text-primary">{feedback}</p>}
            {workspace.loading && <p role="status" className="py-8 text-center text-sm text-secondary">{t('tasks.loading')}</p>}
            {!workspace.loading && !feedback && shown.length === 0 && (
              <p className="py-8 text-center text-sm text-secondary">
                {t(workspace.lists.length === 0 ? 'tasks.noLists' : showCompleted ? 'tasks.noCompleted' : 'tasks.noPending')}
              </p>
            )}
            {shown.length > 0 && (
              <ul className="divide-y divide-hairline" aria-label={t(showCompleted ? 'tasks.completed' : 'tasks.pending')}>
                {shown.map(({ task, listName, color }) => {
                  const overdue = !task.completed && task.dueDate && task.dueDate < today
                  const title = task.title || t('tasks.untitled')
                  const due = task.dueDate ? dateLabel(task.dueDate) : ''
                  return (
                    <li key={task.id}>
                      <label className="flex min-h-12 items-center gap-3 rounded-md px-2.5 py-2 hover:bg-hover" title={task.readOnly ? t('tasks.readOnly') : undefined}>
                        <input type="checkbox" className="h-4 w-4 shrink-0 accent-[var(--accent-color)] disabled:opacity-50"
                          aria-label={title} checked={task.completed} disabled={workspace.busy || task.readOnly} onChange={() => void toggle(task)} />
                        <span className={`min-w-0 flex-1 truncate text-sm ${task.completed ? 'text-secondary line-through' : 'text-primary'}`} title={title}>{title}</span>
                        {!workspace.selectedList && <span className="inline-flex max-w-28 items-center gap-1.5 text-xs text-secondary">
                          {color && <span className="h-2 w-2 shrink-0 rounded-sm" style={{ backgroundColor: color }} />}
                          <span className="truncate">{listName}</span>
                        </span>}
                        {due && <span className="shrink-0 text-xs text-secondary">{overdue ? t('tasks.overdue', { date: due }) : due}</span>}
                      </label>
                    </li>
                  )
                })}
              </ul>
            )}
          </>
        ) : workspace.serversReady ? (
          <div className="flex flex-col items-center gap-3 py-12 text-sm text-secondary">
            <p>{workspace.serverError || t('tasks.noAccount')}</p>
            <button type="button" className="gc-btn-primary" onClick={onAddServer}>{t('tasks.addAccount')}</button>
          </div>
        ) : <p role="status" className="py-8 text-center text-sm text-secondary">{t('tasks.loading')}</p>}
      </div>
    </main>
  )
}
