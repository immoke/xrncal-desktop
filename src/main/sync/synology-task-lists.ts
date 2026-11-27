import type { CalDavTaskListChange } from '@shared/task-model'
import type { CalDavCredentials } from './caldav-adapter'
import { fetchWithTimeout, readTextWithin } from './http'

const calendarFlags = {
  is_hidden_in_cal: false,
  is_hidden_in_list: false,
  notify_alarm_by_browser: true,
  notify_alarm_by_mail: false,
  notify_evt_by_browser: true,
  notify_evt_by_mail: false,
  notify_import_cal_by_browser: true,
  notify_import_cal_by_mail: false
}

type SynologyCalendar = Partial<typeof calendarFlags> & {
  cal_id?: string
  original_cal_id?: string
  cal_type?: string
  cal_description?: string
  cal_privilege?: string
  default_calendar?: boolean
}

function collectionId(href: string): string {
  const path = new URL(href).pathname.replace(/^.*?\/caldav(?:\.php)?(?=\/)/, '')
  return decodeURIComponent(path).replace(/\/+$/, '')
}

/** Synology's Calendar API supports list operations on servers that refuse
 * WebDAV collection deletion. The saved CalDAV sign-in stays in main. */
export async function changeSynologyTaskList(credentials: CalDavCredentials, change: CalDavTaskListChange): Promise<void> {
  const url = new URL('/webapi/entry.cgi', credentials.url).href
  async function request<T>(params: Record<string, string>, token?: string): Promise<T | undefined> {
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      body: new URLSearchParams(params),
      headers: token ? { 'X-SYNO-TOKEN': token } : {},
      redirect: 'error'
    })
    if (!response.ok) throw new Error(`Synology Calendar API: HTTP ${response.status}`)
    const result = JSON.parse(await readTextWithin(response, url, 2 * 1024 * 1024)) as
      { success?: boolean; data?: T; error?: { code?: number } }
    if (result.success !== true) {
      throw new Error(`Synology Calendar API: ${params.method} failed (${result.error?.code ?? 'unknown'})`)
    }
    return result.data
  }

  const auth = { api: 'SYNO.API.Auth', version: '6', session: 'Calendar' }
  const login = await request<{ sid?: string; synotoken?: string }>({
    ...auth, method: 'login', format: 'sid', enable_syno_token: 'yes',
    account: credentials.username, passwd: credentials.password
  })
  const sid = login?.sid
  if (typeof sid !== 'string' || !sid) throw new Error('Synology Calendar API did not return a session')
  const token = typeof login.synotoken === 'string' ? login.synotoken : undefined

  const call = <T>(method: string, params: Record<string, string | boolean>) => {
    // Encode the Calendar API's method parameters as JSON values inside the
    // form. WebAPI's routing and session fields use plain form values.
    const values = Object.fromEntries(Object.entries(params).map(([key, value]) => [key, JSON.stringify(value)]))
    return request<T>({ api: 'SYNO.Cal.Cal', version: '5', method, _sid: sid, ...values }, token)
  }
  try {
    if (change.action === 'create') {
      await call('create', {
        ...calendarFlags,
        cal_type: 'todo', cal_displayname: change.details.name, cal_description: '', cal_color: change.details.color
      })
      return
    }

    const expected = collectionId(change.id)
    const data = await call<{ list?: SynologyCalendar[] }>('list', { cal_type: 'todo' })
    const matches = (Array.isArray(data?.list) ? data.list : []).filter((entry) =>
      entry.cal_type === 'todo' && typeof entry.cal_id === 'string' &&
      [entry.cal_id, entry.original_cal_id].some((id) => id?.replace(/\/+$/, '') === expected)
    )
    const current = matches[0]
    if (matches.length !== 1 || !current.cal_id || current.cal_privilege === 'RO') {
      throw new Error('Synology Calendar API could not identify one writable task list')
    }
    if (change.action === 'delete') {
      if (current.default_calendar) throw new Error('The default task list cannot be deleted')
      await call('delete', { cal_id: current.cal_id })
    } else {
      await call('set', {
        ...Object.fromEntries(Object.entries(calendarFlags).map(([key, fallback]) => [
          key, current[key as keyof typeof calendarFlags] ?? fallback
        ])),
        cal_type: 'todo', cal_id: current.cal_id, original_cal_id: current.original_cal_id ?? current.cal_id,
        cal_displayname: change.details.name, cal_color: change.details.color,
        cal_description: current.cal_description ?? ''
      })
    }
  } finally {
    await request({ ...auth, method: 'logout', _sid: sid }, token).catch(() => undefined)
  }
}
