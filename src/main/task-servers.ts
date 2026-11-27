import { randomUUID } from 'node:crypto'
import type { TaskServer, TaskServerInput } from '@shared/task-model'
import { getDatabase } from './db/database'
import { SecureStore } from './secure-store'
import { CalDavAdapter } from './sync/caldav-adapter'
import { normalizeCalDavUrl, sendsPasswordInClear } from './sync/caldav-discover'

interface SavedTaskServer extends TaskServer {
  password: string
  homeUrl: string
}

const tokenId = 'task-workspace:servers'
const credentialStore = () => new SecureStore(getDatabase())
const records = () => credentialStore().getToken<SavedTaskServer[]>(tokenId) ?? []
const publicServer = ({ id, name, serverUrl, username }: SavedTaskServer): TaskServer => ({ id, name, serverUrl, username })

export function listTaskServers(): TaskServer[] {
  return records().map(publicServer)
}

export function getTaskServer(id: string): SavedTaskServer {
  const server = records().find((record) => record.id === id)
  if (!server) throw new Error('Task server is not configured')
  return server
}

export function removeTaskServer(id: string): void {
  const remaining = records().filter((record) => record.id !== id)
  if (remaining.length) credentialStore().storeToken(tokenId, remaining)
  else credentialStore().deleteToken(tokenId)
}

export async function saveTaskServer(input: TaskServerInput): Promise<TaskServer> {
  const previous = input.id ? getTaskServer(input.id) : undefined
  const serverUrl = input.serverUrl.trim()
  const username = input.username.trim()
  if (serverUrl.includes('://') && !/^https?:\/\//i.test(serverUrl)) throw new Error('Invalid Synology server address')
  const address = new URL(normalizeCalDavUrl('synology', serverUrl, username))
  if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password ||
    address.search || address.hash || sendsPasswordInClear(address.href)) throw new Error('Invalid Synology server address')

  // Never reuse a stored password for a different address or login.
  const sameLogin = previous?.serverUrl === serverUrl && previous.username === username
  const password = input.password || (sameLogin ? previous.password : '')
  if (!password) throw new Error('Enter the password for this Synology server')

  const needsConnection = !sameLogin || Boolean(input.password)
  let homeUrl = previous?.homeUrl ?? address.href
  if (needsConnection) {
    const adapter = new CalDavAdapter({ url: address.href, username, password })
    const found = await adapter.locateCalendarHome()
    if (!found.calendars.length || new URL(found.url).origin !== address.origin) {
      throw new Error('Could not find a CalDAV collection on this Synology server')
    }
    homeUrl = found.url
  }
  const saved: SavedTaskServer = {
    id: previous?.id ?? randomUUID(),
    name: input.name.trim() || address.hostname,
    serverUrl, username, password, homeUrl
  }
  const current = records()
  const latest = current.find((record) => record.id === saved.id)
  if (previous && (!latest || latest.homeUrl !== previous.homeUrl || latest.password !== previous.password ||
    latest.name !== previous.name || latest.username !== previous.username || latest.serverUrl !== previous.serverUrl)) {
    throw new Error('Task server settings have changed')
  }
  if (current.some((record) => record.id !== saved.id && record.homeUrl === homeUrl && record.username === username)) {
    throw new Error('This Synology task server is already configured')
  }
  credentialStore().storeToken(tokenId, previous ? current.map((record) => record.id === saved.id ? saved : record) : [...current, saved])
  return publicServer(saved)
}
