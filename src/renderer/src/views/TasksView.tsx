import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DateTime } from 'luxon'
import { Check, MoreHorizontal, Pencil, Plus, Trash2, X } from 'lucide-react'
import type { CalDavTask, CalDavTaskList, CreateTaskInput, TaskDetails } from '@shared/task-model'
import type { TaskWorkspace } from '../hooks/use-task-workspace'
import { TaskEditorDialog } from '../components/TaskEditorDialog'
import { ContextMenu } from '../components/ui'

type TaskEditor = { mode: 'create' } | { mode: 'edit' | 'delete'; task: CalDavTask }

export default function TasksView({ workspace, dueOn, clearDate, onAddServer }: {
  workspace: TaskWorkspace
  dueOn: string | null
  clearDate: () => void
  onAddServer: () => void
}) {
  const { t, i18n } = useTranslation()
  const [showCompleted, setShowCompleted] = useState(false)
  const [editor, setEditor] = useState<TaskEditor | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; task: CalDavTask } | null>(null)
  const [error, setError] = useState<{ message: string; lists: CalDavTaskList[] } | null>(null)

  async function toggle(task: CalDavTask) {
    if (task.readOnly || workspace.busy) return
    setError(null)
    try {
      const result = await workspace.changeTask(task.id, !task.completed)
      if (result && result !== 'saved') setError({ message: t(`tasks.${result}`), lists: workspace.lists })
    } catch (error) {
      setError({ message: error instanceof Error ? error.message : String(error), lists: workspace.lists })
    }
  }

  async function createTask(input: CreateTaskInput) {
    const task = await workspace.createTask(input)
    if (workspace.selectedList && workspace.selectedList.id !== input.listId) workspace.selectList(input.listId)
    if (dueOn && task.dueDate !== dueOn) clearDate()
    setShowCompleted(false)
    setEditor(null)
  }

  async function changeTask(task: CalDavTask, details: TaskDetails | 'delete') {
    const result = await workspace.changeTask(task.id, details)
    if (result !== 'saved' && result !== 'deleted') throw new Error(t(`tasks.${result}`))
    if (details !== 'delete' && dueOn && details.dueDate !== dueOn) clearDate()
    setEditor(null)
  }

  const writableLists = workspace.lists.filter((list) => list.canEdit)
  const defaultList = workspace.selectedList?.canEdit ? workspace.selectedList : writableLists[0]
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
              <div className="ml-auto flex flex-wrap items-center gap-2">
                {dueOn && (
                  <button type="button" className="gc-btn" onClick={clearDate} title={t('tasks.clearDate')} aria-label={t('tasks.clearDate')}>
                    {dateLabel(dueOn)} <X className="h-3.5 w-3.5" />
                  </button>
                )}
                <button type="button" className="gc-btn-primary" disabled={workspace.busy || !defaultList}
                  onClick={() => setEditor({ mode: 'create' })}>
                  <Plus className="h-4 w-4" />
                  {t('tasks.createTask')}
                </button>
              </div>
            </div>
            {editor?.mode === 'create' && defaultList && <TaskEditorDialog mode="create"
              lists={writableLists} defaultListId={defaultList.id} defaultDueDate={dueOn ?? ''}
              onSave={createTask} onClose={() => setEditor(null)} />}
            {editor?.mode === 'edit' && <TaskEditorDialog mode="edit" task={editor.task}
              onSave={(details) => changeTask(editor.task, details)} onClose={() => setEditor(null)} />}
            {editor?.mode === 'delete' && <TaskEditorDialog mode="delete" task={editor.task}
              onSave={() => changeTask(editor.task, 'delete')} onClose={() => setEditor(null)} />}
            <ContextMenu at={menu} onClose={() => setMenu(null)} entries={menu ? [
              { label: t('tasks.editTask'), icon: <Pencil className="h-3.5 w-3.5" />,
                disabled: menu.task.readOnly || workspace.busy, onSelect: () => setEditor({ mode: 'edit', task: menu.task }) },
              { label: t('tasks.deleteTask'), icon: <Trash2 className="h-3.5 w-3.5" />, danger: true,
                disabled: menu.task.readOnly || workspace.busy, onSelect: () => setEditor({ mode: 'delete', task: menu.task }) }
            ] : []} />
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
                    <li key={task.id} className="flex min-h-12 items-center gap-3 rounded-md px-2.5 py-2 hover:bg-hover"
                      title={task.readOnly ? t('tasks.readOnly') : undefined} onDoubleClick={() => void toggle(task)}>
                        <button type="button" role="checkbox" aria-label={title} aria-checked={task.completed}
                          className="gc-icon-btn h-7 w-7 shrink-0" disabled={workspace.busy || task.readOnly}
                          onClick={(event) => { if (event.detail < 2) void toggle(task) }}
                          onDoubleClick={(event) => event.stopPropagation()}>
                          <span aria-hidden="true" className={`grid h-4 w-4 place-items-center rounded-full border ${task.completed ? 'border-accent bg-accent text-white' : 'border-current text-muted'}`}>
                            {task.completed && <Check className="h-3 w-3" />}
                          </span>
                        </button>
                        <span className={`min-w-0 flex-1 truncate text-sm ${task.completed ? 'text-secondary line-through' : 'text-primary'}`} title={title}>{title}</span>
                        {!workspace.selectedList && <span className="inline-flex max-w-28 items-center gap-1.5 text-xs text-secondary">
                          {color && <span className="h-2 w-2 shrink-0 rounded-sm" style={{ backgroundColor: color }} />}
                          <span className="truncate">{listName}</span>
                        </span>}
                        {due && <span className="shrink-0 text-xs text-secondary">{overdue ? t('tasks.overdue', { date: due }) : due}</span>}
                        <button type="button" className="gc-icon-btn h-7 w-7 shrink-0" aria-haspopup="menu"
                          aria-expanded={menu?.task.id === task.id} aria-label={t('tasks.taskOptions', { name: title })}
                          onDoubleClick={(event) => event.stopPropagation()} onClick={(event) => {
                            const box = event.currentTarget.getBoundingClientRect()
                            setMenu({ x: box.left, y: box.bottom + 3, task })
                          }}>
                          <MoreHorizontal className="h-4 w-4" />
                        </button>
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
