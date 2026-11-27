import { randomUUID } from 'node:crypto'
import type { CalDavTask, CalDavTaskList, CreateTaskInput, TaskDeleteResult, TaskDetails, TaskUpdateResult } from '@shared/task-model'
import { readTaskIcs, writeNewTaskIcs, writeTaskCompletion, writeTaskDetails } from '../ics/task-ics'
import { CalDavAdapter, CalDavQueryError, CalDavTaskResourceError, type CalDavItem } from './caldav-adapter'
import type { CalDavCalendarDescriptor } from './caldav-discover'

interface ListedTask {
  task: CalDavTask
  href: string
  etag?: string
  ics: string
  uid: string
  listReadOnly: boolean
}

type TaskCopy = NonNullable<ReturnType<typeof readTaskIcs>>

function matchesSnapshot(before: ListedTask, resource: CalDavItem & { ics: string }): boolean {
  return before.etag ? before.etag === resource.etag : before.ics.trimEnd() === resource.ics.trimEnd()
}

function isInbox(url: URL): boolean {
  return /\/home_todo\/?$/i.test(url.pathname)
}

// Some Synology installations expose the default task collection even when their
// home discovery omits it. Keep the probe on the saved account's origin.
function inboxFallback(home: URL, username: string): string | undefined {
  const dav = /^(.*\/caldav)(?:\.php)?(?:\/|$)/i.exec(home.pathname)
  return dav ? new URL(`${dav[1]}.php/${encodeURIComponent(username)}/home_todo/`, home).href : undefined
}

function listedTask(item: CalDavItem, id: string, listReadOnly: boolean): ListedTask | null {
  if (!item.ics) return null
  const parsed = readTaskIcs(item.ics)
  if (!parsed) return null
  return {
    task: {
      id,
      title: parsed.title,
      dueDate: parsed.dueDate,
      dueTime: parsed.dueTime,
      description: parsed.description,
      reminderMinutes: parsed.reminderMinutes,
      completed: parsed.completed,
      readOnly: listReadOnly || parsed.readOnly
    },
    href: item.href,
    etag: item.etag,
    ics: item.ics,
    uid: parsed.uid,
    listReadOnly
  }
}

function isCollectionMember(href: string, list: URL): boolean {
  const item = new URL(href)
  return item.origin === list.origin &&
    item.pathname.startsWith(`${list.pathname.replace(/\/+$/, '')}/`) &&
    item.pathname !== list.pathname
}

/** The renderer gets opaque task IDs. Only resources discovered by this
 * account's CalDAV session can be updated, and each edit is conditional. */
export class CalDavTaskSession {
  private snapshots = new Map<string, Map<string, ListedTask>>()
  private collections = new Map<string, CalDavTaskList[]>()

  async list(accountId: string, adapter: CalDavAdapter, home: URL, username: string): Promise<CalDavTaskList[]> {
    const snapshot = new Map<string, ListedTask>()
    const lists: CalDavTaskList[] = []
    const candidates = new Map<string, CalDavCalendarDescriptor>()
    for (const descriptor of await adapter.discoverCalendars(true)) {
      const url = new URL(descriptor.href, home)
      if (url.origin === home.origin && descriptor.supportsTasks !== false) candidates.set(url.href, descriptor)
    }
    const fallback = inboxFallback(home, username)
    if (fallback && !Array.from(candidates.keys()).some((href) => isInbox(new URL(href)))) {
      candidates.set(fallback, { href: fallback, displayName: '' })
    }

    for (const [href, descriptor] of candidates) {
      const url = new URL(href)
      let items: CalDavItem[]
      try {
        items = await adapter.pullCalendarTasks(href)
      } catch (err) {
        if (descriptor.supportsTasks !== true && err instanceof CalDavQueryError &&
          [400, 403, 404, 405, 415, 501].includes(err.status)) continue
        throw err
      }
      const tasks: CalDavTask[] = []
      const seen = new Set<string>()
      for (const item of items) {
        if (!isCollectionMember(item.href, url) || seen.has(item.href)) continue
        const row = listedTask(item, randomUUID(), descriptor.isReadOnly === true)
        if (!row) continue
        seen.add(item.href)
        snapshot.set(row.task.id, row)
        tasks.push(row.task)
      }
      if (descriptor.supportsTasks === true || tasks.length > 0 || isInbox(url)) {
        const canEdit = !descriptor.isReadOnly && descriptor.supportsEvents !== true
        lists.push({ id: href, name: descriptor.displayName, color: descriptor.color, canEdit, canDelete: canEdit && !isInbox(url), tasks })
      }
    }
    this.snapshots.set(accountId, snapshot)
    this.collections.set(accountId, lists)
    return lists
  }

  forget(accountId: string): void {
    this.snapshots.delete(accountId)
    this.collections.delete(accountId)
  }

  requireEditableList(accountId: string, home: URL, id: string, deleting: boolean): void {
    const list = this.collections.get(accountId)?.find((item) => item.id === id)
    if (!list?.canEdit || (deleting && !list.canDelete) || new URL(id).origin !== home.origin) {
      throw new Error('This task list cannot be changed')
    }
  }

  async createTask(accountId: string, adapter: CalDavAdapter, home: URL, input: CreateTaskInput): Promise<CalDavTask> {
    this.requireEditableList(accountId, home, input.listId, false)
    const listUrl = new URL(input.listId)
    listUrl.pathname = `${listUrl.pathname.replace(/\/+$/, '')}/${input.requestId}.ics`
    const href = listUrl.href
    const uid = `${input.requestId}@xrncal`
    const ics = writeNewTaskIcs(uid, input)
    const result = await adapter.putIcs(href, ics, { ifNoneMatch: '*' })
    const resource = await adapter.readTaskResource(href).catch((error: unknown) => {
      if (!result.success) throw error
      return { href, ics, etag: result.etag }
    })
    // A retry after a lost reply can find the task already saved under this UID.
    const snapshot = this.snapshots.get(accountId)
    const existing = snapshot && Array.from(snapshot.values()).find((item) => item.href === href)
    const stored = listedTask(resource, existing?.task.id ?? input.requestId, false)
    if (!stored || stored.uid !== uid) throw new Error('Could not confirm the saved task')
    snapshot?.set(stored.task.id, stored)
    return stored.task
  }

  async setCompleted(
    accountId: string, adapter: CalDavAdapter, accountOrigin: string, id: string, completed: boolean
  ): Promise<TaskUpdateResult> {
    return this.updateTask(accountId, adapter, accountOrigin, id,
      (task) => task.completed === completed, (copy) => writeTaskCompletion(copy, completed))
  }

  async setDetails(
    accountId: string, adapter: CalDavAdapter, accountOrigin: string, id: string, details: TaskDetails
  ): Promise<TaskUpdateResult> {
    return this.updateTask(accountId, adapter, accountOrigin, id,
      (task) => task.title === details.title && task.dueDate === details.dueDate &&
        (details.dueTime === undefined || task.dueTime === (details.dueTime ?? undefined)) &&
        (details.description === undefined || (task.description ?? '') === details.description) &&
        (details.reminderMinutes === undefined || details.reminderMinutes.join() === task.reminderMinutes?.join()),
      (copy) => writeTaskDetails(copy, details))
  }

  async deleteTask(accountId: string, adapter: CalDavAdapter, accountOrigin: string, id: string): Promise<TaskDeleteResult> {
    const source = await this.readEditableTask(accountId, adapter, accountOrigin, id)
    if (source.status !== 'ready') {
      if (source.status !== 'missing') return source.status
      this.snapshots.get(accountId)?.delete(id)
      return 'deleted'
    }
    const { snapshot, before, resource } = source
    if (!matchesSnapshot(before, resource)) return 'changed'
    if (!resource.etag) return 'readOnly'
    const result = await adapter.deleteResource(before.href, resource.etag, 'error')
    if (result === 'conflict') return 'changed'
    if (!result) throw new Error('The server could not delete this task')
    snapshot.delete(id)
    return 'deleted'
  }

  private async readEditableTask(accountId: string, adapter: CalDavAdapter, accountOrigin: string, id: string) {
    const snapshot = this.snapshots.get(accountId)
    const before = snapshot?.get(id)
    if (!snapshot || !before || new URL(before.href).origin !== accountOrigin) return { status: 'changed' as const }
    if (before.task.readOnly) return { status: 'readOnly' as const }
    const resource = await adapter.readTaskResource(before.href).catch((error: unknown) => {
      if (error instanceof CalDavTaskResourceError && [404, 410].includes(error.status)) return null
      throw error
    })
    if (!resource) return { status: 'missing' as const }
    const live = readTaskIcs(resource.ics)
    if (!live || live.uid !== before.uid) return { status: 'changed' as const }
    if (live.readOnly) return { status: 'readOnly' as const }
    return { status: 'ready' as const, snapshot, before, live, resource }
  }

  private async updateTask(
    accountId: string, adapter: CalDavAdapter, accountOrigin: string, id: string,
    matches: (task: CalDavTask | TaskCopy) => boolean,
    serialize: (copy: TaskCopy) => string
  ): Promise<TaskUpdateResult> {
    const source = await this.readEditableTask(accountId, adapter, accountOrigin, id)
    if (source.status !== 'ready') return { status: source.status === 'missing' ? 'changed' : source.status }
    const { snapshot, before, live, resource } = source
    let confirmed = resource
    if (!matches(live)) {
      if (!matchesSnapshot(before, resource)) return { status: 'changed' }
      if (!resource.etag) return { status: 'readOnly' }
      const result = await adapter.putIcs(before.href, serialize(live), { ifMatch: resource.etag })
      if (result.conflict) return { status: 'changed' }
      confirmed = await adapter.readTaskResource(before.href)
    }

    const saved = listedTask(confirmed, id, before.listReadOnly)
    if (!saved || saved.uid !== before.uid || !matches(saved.task)) return { status: 'unconfirmed' }
    snapshot.set(id, saved)
    return { status: 'saved', task: saved.task }
  }
}
