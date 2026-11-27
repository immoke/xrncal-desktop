export interface CalDavTask extends Omit<TaskDetails, 'dueTime'> {
  id: string
  listId: string
  dueTime?: string
  completed: boolean
  readOnly: boolean
}

export const MAX_TASK_TITLE_LENGTH = 255
export const MAX_TASK_DESCRIPTION_LENGTH = 8192
export const MAX_TASK_REMINDERS = 5

export interface TaskDetails {
  title: string
  dueDate?: string
  /** Local HH:mm, null for a date-only deadline, omitted to keep the existing time. */
  dueTime?: string | null
  description?: string
  /** Display alarms in minutes before the deadline. Omitted to keep existing alarms. */
  reminderMinutes?: number[]
}

export interface CreateTaskInput extends TaskDetails {
  /** Kept across retries of the same form submission. */
  requestId: string
  listId: string
}

export interface UpdateTaskInput extends TaskDetails {
  listId: string
}

export interface CalDavTaskList {
  id: string
  name: string
  color?: string
  canEdit: boolean
  canDelete: boolean
  tasks: CalDavTask[]
}

export interface CalDavTaskListDetails {
  name: string
  color: string
}

export type CalDavTaskListChange =
  | { action: 'create'; details: CalDavTaskListDetails }
  | { action: 'update'; id: string; details: CalDavTaskListDetails }
  | { action: 'delete'; id: string }

export interface TaskServer {
  id: string
  name: string
  serverUrl: string
  username: string
}

export interface TaskServerInput extends Omit<TaskServer, 'id'> {
  id?: string
  password: string
}

export type TaskUpdateResult =
  | { status: 'saved'; task: CalDavTask }
  | { status: 'changed' | 'readOnly' | 'unconfirmed' }

export type TaskDeleteResult = 'deleted' | 'changed' | 'readOnly'
