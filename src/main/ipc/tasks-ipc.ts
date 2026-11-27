import { ipcMain } from 'electron'
import { DateTime } from 'luxon'
import { IPC_CHANNELS } from '@shared/ipc-contract'
import { MAX_REMINDER_MINUTES } from '@shared/reminders'
import {
  MAX_TASK_DESCRIPTION_LENGTH, MAX_TASK_REMINDERS, MAX_TASK_TITLE_LENGTH,
  type CalDavTaskListChange, type CreateTaskInput, type TaskDetails, type TaskServerInput
} from '@shared/task-model'
import { getTaskServer, listTaskServers, removeTaskServer, saveTaskServer } from '../task-servers'
import { CalDavAdapter } from '../sync/caldav-adapter'
import { CalDavTaskSession } from '../sync/caldav-tasks'
import { changeSynologyTaskList } from '../sync/synology-task-lists'

function connectedAdapter(accountId: string) {
  const server = getTaskServer(accountId)
  const credentials = { url: server.homeUrl, username: server.username, password: server.password }
  return { adapter: new CalDavAdapter(credentials), url: new URL(credentials.url), credentials }
}

function serverInput(input: unknown): TaskServerInput {
  if (typeof input !== 'object' || input === null) throw new Error('Invalid task server')
  const { id, name, serverUrl, username, password } = input as Record<string, unknown>
  if ((id !== undefined && typeof id !== 'string') || typeof name !== 'string' ||
    typeof serverUrl !== 'string' || !serverUrl.trim() || typeof username !== 'string' || !username.trim() ||
    typeof password !== 'string') throw new Error('Invalid task server settings')
  return { id, name, serverUrl, username, password }
}

function listChange(input: unknown): CalDavTaskListChange {
  if (typeof input !== 'object' || input === null) throw new Error('Invalid task list change')
  const { action, id, details } = input as Record<string, unknown>
  if (action === 'delete' && typeof id === 'string') return { action, id }
  if ((action !== 'create' && action !== 'update') || typeof details !== 'object' || details === null) {
    throw new Error('Invalid task list change')
  }
  const { name, color } = details as Record<string, unknown>
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 120 || typeof color !== 'string' ||
    !/^#[\da-f]{6}$/i.test(color)) throw new Error('Invalid task list name or colour')
  const values = { name: name.trim(), color: color.toUpperCase() }
  if (action === 'create') return { action, details: values }
  if (typeof id !== 'string') throw new Error('Invalid task list')
  return { action, id, details: values }
}

function taskDetails(input: unknown): TaskDetails {
  if (typeof input !== 'object' || input === null) throw new Error('Invalid task details')
  const { title, dueDate, dueTime, description, reminderMinutes } = input as Record<string, unknown>
  if (typeof title !== 'string' || !title.trim() || title.trim().length > MAX_TASK_TITLE_LENGTH) throw new Error('Invalid task name')
  if (dueDate !== undefined && (typeof dueDate !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || !DateTime.fromISO(dueDate, { zone: 'UTC' }).isValid)) {
    throw new Error('Invalid task due date')
  }
  if (dueTime !== undefined && dueTime !== null) {
    if (typeof dueTime !== 'string' || !/^\d{2}:\d{2}$/.test(dueTime) || !dueDate) throw new Error('Invalid task due time')
    const deadline = DateTime.fromISO(`${dueDate}T${dueTime}`)
    if (deadline.toFormat("yyyy-MM-dd'T'HH:mm") !== `${dueDate}T${dueTime}`) throw new Error('Invalid task due time')
  }
  if (description !== undefined && (typeof description !== 'string' || description.length > MAX_TASK_DESCRIPTION_LENGTH)) {
    throw new Error('Invalid task description')
  }
  if (reminderMinutes !== undefined && (!Array.isArray(reminderMinutes) || reminderMinutes.length > MAX_TASK_REMINDERS ||
    !reminderMinutes.every((minutes: unknown) => typeof minutes === 'number' && Number.isInteger(minutes) &&
      minutes >= 0 && minutes <= MAX_REMINDER_MINUTES))) {
    throw new Error('Invalid task reminders')
  }
  return {
    title: title.trim(), dueDate, dueTime, description: description?.replace(/\r\n?/g, '\n'),
    reminderMinutes: reminderMinutes && Array.from(new Set<number>(reminderMinutes)).sort((a, b) => a - b)
  }
}

function createInput(input: unknown): CreateTaskInput {
  if (typeof input !== 'object' || input === null) throw new Error('Invalid new task')
  const { requestId, listId } = input as Record<string, unknown>
  if (typeof requestId !== 'string' || !/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(requestId) ||
    typeof listId !== 'string') throw new Error('Invalid new task')
  return { requestId, listId, ...taskDetails(input) }
}

export function registerTasksIpcHandlers(): void {
  const session = new CalDavTaskSession()
  const { SERVERS, SAVE_SERVER, REMOVE_SERVER, LIST, CREATE, UPDATE, DELETE, SET_COMPLETED, CHANGE_LIST } = IPC_CHANNELS.TASKS
  for (const channel of Object.values(IPC_CHANNELS.TASKS)) ipcMain.removeHandler(channel)

  ipcMain.handle(SERVERS, listTaskServers)
  ipcMain.handle(SAVE_SERVER, async (_event, input: unknown) => {
    const server = await saveTaskServer(serverInput(input))
    session.forget(server.id)
    return server
  })
  ipcMain.handle(REMOVE_SERVER, (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('Invalid task server')
    removeTaskServer(id)
    session.forget(id)
  })
  ipcMain.handle(LIST, (_event, accountId: unknown) => {
    if (typeof accountId !== 'string') throw new Error('Invalid CalDAV account')
    const { adapter, url, credentials } = connectedAdapter(accountId)
    return session.list(accountId, adapter, url, credentials.username)
  })
  ipcMain.handle(CREATE, (_event, accountId: unknown, input: unknown) => {
    if (typeof accountId !== 'string') throw new Error('Invalid task server')
    const { adapter, url } = connectedAdapter(accountId)
    return session.createTask(accountId, adapter, url, createInput(input))
  })
  ipcMain.handle(UPDATE, (_event, accountId: unknown, id: unknown, input: unknown) => {
    if (typeof accountId !== 'string' || typeof id !== 'string') throw new Error('Invalid task update')
    const { adapter, url } = connectedAdapter(accountId)
    return session.setDetails(accountId, adapter, url.origin, id, taskDetails(input))
  })
  ipcMain.handle(DELETE, (_event, accountId: unknown, id: unknown) => {
    if (typeof accountId !== 'string' || typeof id !== 'string') throw new Error('Invalid task deletion')
    const { adapter, url } = connectedAdapter(accountId)
    return session.deleteTask(accountId, adapter, url.origin, id)
  })
  ipcMain.handle(SET_COMPLETED, (_event, accountId: unknown, id: unknown, completed: unknown) => {
    if (typeof accountId !== 'string' || typeof id !== 'string' || typeof completed !== 'boolean') {
      throw new Error('Invalid task update')
    }
    const { adapter, url } = connectedAdapter(accountId)
    return session.setCompleted(accountId, adapter, url.origin, id, completed)
  })
  ipcMain.handle(CHANGE_LIST, async (_event, accountId: unknown, input: unknown) => {
    if (typeof accountId !== 'string') throw new Error('Invalid CalDAV account')
    const change = listChange(input)
    const { url, credentials } = connectedAdapter(accountId)
    if (change.action !== 'create') {
      session.requireEditableList(accountId, url, change.id, change.action === 'delete')
    }
    return changeSynologyTaskList(credentials, change)
  })
}
