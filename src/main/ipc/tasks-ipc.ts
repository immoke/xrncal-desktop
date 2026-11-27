import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '@shared/ipc-contract'
import type { CalDavTaskListChange, TaskServerInput } from '@shared/task-model'
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

export function registerTasksIpcHandlers(): void {
  const session = new CalDavTaskSession()
  const { SERVERS, SAVE_SERVER, REMOVE_SERVER, LIST, SET_COMPLETED, CHANGE_LIST } = IPC_CHANNELS.TASKS
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
