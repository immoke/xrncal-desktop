import { randomUUID } from 'node:crypto'
import type { CalDavTask, CalDavTaskList, TaskUpdateResult } from '@shared/task-model'
import { readTaskIcs, writeTaskCompletion } from '../ics/task-ics'
import { CalDavAdapter, CalDavQueryError, type CalDavItem } from './caldav-adapter'
import type { CalDavCalendarDescriptor } from './caldav-discover'

interface ListedTask {
  task: CalDavTask
  href: string
  etag?: string
  ics: string
  uid: string
  listReadOnly: boolean
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

  async setCompleted(
    accountId: string, adapter: CalDavAdapter, accountOrigin: string, id: string, completed: boolean
  ): Promise<TaskUpdateResult> {
    const snapshot = this.snapshots.get(accountId)
    const before = snapshot?.get(id)
    if (!snapshot || !before || new URL(before.href).origin !== accountOrigin) return { status: 'changed' }
    if (before.task.readOnly) return { status: 'readOnly' }

    const resource = await adapter.readTaskResource(before.href)
    const live = readTaskIcs(resource.ics)
    if (!live || live.uid !== before.uid) return { status: 'changed' }
    if (live.readOnly) return { status: 'readOnly' }
    if (live.completed !== completed) {
      // Where REPORT omits an ETag, compare its copy before using GET's ETag.
      if (before.etag ? before.etag !== resource.etag : before.ics.trimEnd() !== resource.ics.trimEnd()) {
        return { status: 'changed' }
      }
      if (!resource.etag) return { status: 'readOnly' }
      const result = await adapter.putIcs(before.href, writeTaskCompletion(live, completed), resource.etag)
      if (result.conflict) return { status: 'changed' }
    }

    // Confirm what another client will read, even when the server rewrites the
    // payload or acknowledges the PUT without including a new ETag.
    const saved = listedTask(await adapter.readTaskResource(before.href), id, before.listReadOnly)
    if (!saved || saved.uid !== before.uid || saved.task.completed !== completed) return { status: 'unconfirmed' }
    snapshot.set(id, saved)
    return { status: 'saved', task: saved.task }
  }
}
