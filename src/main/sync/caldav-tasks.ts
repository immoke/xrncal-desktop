import { createHash, randomUUID } from 'node:crypto'
import type {
  CalDavTask, CalDavTaskList, CreateTaskInput, TaskDeleteResult, TaskDetails, TaskUpdateResult, UpdateTaskInput
} from '@shared/task-model'
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
type TaskMatch = (task: CalDavTask | TaskCopy) => boolean

function sameDetails(task: CalDavTask | TaskCopy, details: TaskDetails): boolean {
  return task.title === details.title && task.dueDate === details.dueDate &&
    (details.dueTime === undefined || task.dueTime === (details.dueTime ?? undefined)) &&
    (details.description === undefined || (task.description ?? '') === details.description) &&
    (details.reminderMinutes === undefined || details.reminderMinutes.join() === task.reminderMinutes?.join())
}

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

function listedTask(item: CalDavItem, id: string, listId: string, listReadOnly: boolean): ListedTask | null {
  if (!item.ics) return null
  const parsed = readTaskIcs(item.ics)
  if (!parsed) return null
  return {
    task: {
      id,
      listId,
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

function resourceUrl(listId: string, name: string): string {
  const url = new URL(listId)
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${name}.ics`
  return url.href
}

async function readTaskAt(adapter: CalDavAdapter, href: string) {
  try {
    return await adapter.readTaskResource(href)
  } catch (error) {
    if (error instanceof CalDavTaskResourceError && [404, 410].includes(error.status)) return null
    throw error
  }
}

function taskContent(ics: string): string {
  // Saving the same edits again generates new bookkeeping timestamps.
  return ics.replace(/\r\n/g, '\n').replace(/^(?:DTSTAMP|LAST-MODIFIED):[^\n]*\n/gm, '').trimEnd()
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
        const row = listedTask(item, randomUUID(), href, descriptor.isReadOnly === true)
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
    const href = resourceUrl(input.listId, input.requestId)
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
    const stored = listedTask(resource, existing?.task.id ?? input.requestId, input.listId, false)
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
    accountId: string, adapter: CalDavAdapter, home: URL, id: string, input: UpdateTaskInput
  ): Promise<TaskUpdateResult> {
    const snapshot = this.snapshots.get(accountId)
    const before = snapshot?.get(id)
    if (!snapshot || !before) return { status: 'changed' }
    const matches: TaskMatch = (task) => sameDetails(task, input)
    if (input.listId === before.task.listId) {
      return this.updateTask(accountId, adapter, home.origin, id, matches, (copy) => writeTaskDetails(copy, input))
    }
    this.requireEditableList(accountId, home, input.listId, false)
    const target = resourceUrl(input.listId, createHash('sha256').update(before.uid).digest('hex'))
    const source = await this.readEditableTask(accountId, adapter, home.origin, id)
    const confirm = async (): Promise<TaskUpdateResult> => {
      const resource = await readTaskAt(adapter, target)
      const saved = resource && listedTask(resource, id, input.listId, false)
      if (!saved || saved.uid !== before.uid || !matches(saved.task)) return { status: 'unconfirmed' }
      snapshot.set(id, saved)
      return { status: 'saved', task: saved.task }
    }
    // A previous MOVE or DELETE may have succeeded before its reply was lost.
    if (source.status === 'missing') return confirm()
    if (source.status !== 'ready') return { status: source.status }
    if (!matchesSnapshot(before, source.resource)) return { status: 'changed' }
    const { etag, ics } = source.resource
    if (!etag) return { status: 'readOnly' }
    if (matches(source.live)) {
      const moved = await adapter.moveTaskResource(before.href, target, etag)
      if (moved === 'moved') return confirm()
      if (moved === 'conflict') return { status: 'changed' }
    }
    // A server without MOVE, or a move with edits, needs the complete VTODO
    // saved in the destination before we may remove its original.
    const content = matches(source.live) ? ics : writeTaskDetails(source.live, input)
    const result = await this.copyThenRemoveTask(adapter, before, etag, target, input.listId, content, matches)
    if (result.status === 'saved') {
      snapshot.set(id, result.saved)
      return { status: 'saved', task: result.saved.task }
    }
    return result
  }

  private async copyThenRemoveTask(
    adapter: CalDavAdapter, before: ListedTask, etag: string, target: string, listId: string,
    content: string, matches: TaskMatch
  ): Promise<{ status: 'saved'; saved: ListedTask } | { status: 'changed' | 'unconfirmed' }> {
    const put = await adapter.putIcs(target, content, { ifNoneMatch: '*' })
    const resource = await readTaskAt(adapter, target)
    const saved = resource && listedTask(resource, before.task.id, listId, false)
    if (!saved || saved.uid !== before.uid || !matches(saved.task)) {
      return { status: put.conflict ? 'changed' : 'unconfirmed' }
    }
    const exact = taskContent(saved.ics) === taskContent(content)
    if (put.conflict && !exact) return { status: 'changed' }
    if (put.etag && saved.etag !== put.etag) return { status: 'changed' }

    const removed = await adapter.deleteResource(before.href, etag, 'error').catch(() => false)
    if (removed === true) return { status: 'saved', saved }
    const remaining = await readTaskAt(adapter, before.href).catch(() => undefined)
    if (remaining === null) return { status: 'saved', saved }
    // Undo a confirmed copy only while the original is still known to
    // exist. If its state is unknown, keep the data on both sides.
    if (remaining && readTaskIcs(remaining.ics)?.uid === before.uid && saved.etag &&
      (exact || saved.etag === put.etag)) {
      await adapter.deleteResource(target, saved.etag, 'error').catch(() => false)
    }
    return { status: removed === 'conflict' ? 'changed' : 'unconfirmed' }
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
    const resource = await readTaskAt(adapter, before.href)
    if (!resource) return { status: 'missing' as const }
    const live = readTaskIcs(resource.ics)
    if (!live || live.uid !== before.uid) return { status: 'changed' as const }
    if (live.readOnly) return { status: 'readOnly' as const }
    return { status: 'ready' as const, snapshot, before, live, resource }
  }

  private async updateTask(
    accountId: string, adapter: CalDavAdapter, accountOrigin: string, id: string,
    matches: TaskMatch,
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

    const saved = listedTask(confirmed, id, before.task.listId, before.listReadOnly)
    if (!saved || saved.uid !== before.uid || !matches(saved.task)) return { status: 'unconfirmed' }
    snapshot.set(id, saved)
    return { status: 'saved', task: saved.task }
  }
}
