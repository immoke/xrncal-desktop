import { createHash } from 'node:crypto'
import { fetchWithTimeout, readTextWithin } from './http'
import { generateIcs } from '../ics/write-ics'
import { mergeServerCopy } from '../ics/merge-ics'
import {
  parseCalDavMultistatus,
  extractXmlText,
  extractPropHref,
  mayCarryCredentials,
  multistatusResponses,
  normalizeCalendarColor,
  resolveDavHref,
  type CalDavCalendarDescriptor
} from './caldav-discover'
import type { Calendar, CalendarEvent, EventException } from '@shared/event-model'

/** A calendar resource from a REPORT; `ics` is absent when only etags were asked for. */
export interface CalDavItem {
  href: string
  ics?: string
  etag?: string
}

/** Resources per calendar-multiget request. */
const MULTIGET_BATCH = 100
/** A whole calendar of ~8,000 events is a few MB of XML; this is far past any real one. */
const MAX_REPORT_BYTES = 200 * 1024 * 1024
/** Time allowed for a REPORT's body once its headers are in. */
const REPORT_BODY_TIMEOUT_MS = 120_000
/** A calendar list or a principal lookup is a few KB; a server sending more is
 *  not answering the question, and is not let fill memory. */
const MAX_DISCOVERY_BYTES = 20 * 1024 * 1024

export class CalDavQueryError extends Error {
  constructor(readonly status: number, component: string) {
    super(`CalDAV ${component === 'VEVENT' ? 'event' : 'task'} query failed with HTTP ${status}`)
  }
}

export class CalDavTaskResourceError extends Error {
  constructor(readonly status: number) {
    super(`CalDAV task read failed with HTTP ${status}`)
  }
}

/** The start of a failed response's body, for the error message - not all of
 *  whatever a server chose to send. */
async function failureText(res: Response): Promise<string> {
  try {
    return (await readTextWithin(res, res.url, 64 * 1024)).slice(0, 500)
  } catch {
    return ''
  }
}

export interface CalDavCredentials {
  url: string
  username: string
  password: string
}

export class CalDavAdapter {
  private authHeader: string

  constructor(private creds: CalDavCredentials) {
    const token = Buffer.from(`${creds.username}:${creds.password}`).toString('base64')
    this.authHeader = `Basic ${token}`
  }

  /**
   * Helper: Dispatch CalDAV HTTP request with Basic Auth
   */
  private async request(
    url: string,
    method: string,
    body?: string,
    headers: Record<string, string> = {},
    redirect?: RequestRedirect
  ): Promise<Response> {
    // Only to the account's own server (mayCarryCredentials); anywhere else the
    // request goes without the password and fails with a 401 instead.
    const auth: Record<string, string> = mayCarryCredentials(this.creds.url, url) ? { Authorization: this.authHeader } : {}
    return fetchWithTimeout(url, {
      method,
      headers: {
        ...auth,
        ...headers
      },
      body,
      redirect
    })
  }

  /**
   * Discover calendar collections via PROPFIND
   */
  async discoverCalendars(includeTaskSupport = false): Promise<CalDavCalendarDescriptor[]> {
    // No sync-token: nothing uses it, and Radicale rebuilds per-item history to
    // answer it - 2 to 25 s per poll on the home server's 8,000 events, against
    // 1.6 s for the ctag alone, which is all that decides whether to pull.
    const propfindXml = `<?xml version="1.0" encoding="utf-8" ?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/" xmlns:I="http://apple.com/ns/ical/">
  <D:prop>
    <D:resourcetype/>
    <D:displayname/>
    <C:calendar-description/>${includeTaskSupport ? '\n    <C:supported-calendar-component-set/>' : ''}
    <I:calendar-color/>
    <CS:getctag/>
    <D:current-user-privilege-set/>
  </D:prop>
</D:propfind>`

    const res = await this.request(this.creds.url, 'PROPFIND', propfindXml, {
      Depth: '1',
      'Content-Type': 'application/xml; charset=utf-8'
    })

    if (!res.ok && res.status !== 207) {
      throw new Error(`CalDAV discovery failed with HTTP ${res.status}: ${await failureText(res)}`)
    }

    const xml = await readTextWithin(res, res.url || this.creds.url, MAX_DISCOVERY_BYTES)
    if (!isMultistatus(xml)) {
      throw new Error(`CalDAV discovery got HTTP ${res.status} without a multistatus answer`)
    }
    return parseCalDavMultistatus(xml, this.creds.url)
  }

  /** Verify the collection itself when it is missing from the home listing. */
  async isCalendarGone(calendarUrl: string): Promise<boolean> {
    if (!mayCarryCredentials(this.creds.url, calendarUrl)) return false
    const target = new URL(calendarUrl).href
    const res = await this.request(
      calendarUrl,
      'PROPFIND',
      '<D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>',
      { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' }
    )
    if (res.url && res.url !== target) {
      await res.body?.cancel().catch(() => {})
      return false
    }
    if (res.status === 207) {
      const xml = await readTextWithin(res, calendarUrl, MAX_DISCOVERY_BYTES)
      return isMultistatus(xml) && multistatusResponses(xml).some((response) => {
        // A missing property in a propstat does not say the collection is gone.
        if (/<(?:[\w-]+:)?propstat[\s>]/i.test(response)) return false
        const href = extractXmlText(response, 'href')
        const status = extractXmlText(response, 'status') ?? ''
        return Boolean(href && resolveDavHref(href, calendarUrl) === target &&
          /^HTTP\/\S+\s+(?:404|410)(?:\s|$)/i.test(status))
      })
    }
    await res.body?.cancel().catch(() => {})
    return res.status === 404 || res.status === 410
  }

  /**
   * Find the user's calendars from whatever address they typed - a server root,
   * a principal or the calendar home itself - the way RFC 6764 clients "auto
   * detect": calendars at the address, else follow `current-user-principal`
   * (asking `/.well-known/caldav` when the address does not say) to its
   * `calendar-home-set`. Without this, a bare server URL connected "fine" and
   * then showed no calendars, because they live one or two levels down.
   *
   * Returns the URL to store as the account's base, so every later sync lists
   * calendars with the single PROPFIND in `discoverCalendars`.
   */
  async locateCalendarHome(): Promise<{ url: string; calendars: CalDavCalendarDescriptor[] }> {
    const start = this.creds.url
    const here = await this.calendarsAt(start)
    if (here.length > 0) return { url: start, calendars: here }

    const principal =
      (await this.propHref(start, 'current-user-principal')) ??
      (await this.propHref(resolveDavHref('/.well-known/caldav', start), 'current-user-principal'))
    if (!principal) return { url: start, calendars: [] }

    const home = await this.propHref(principal, 'calendar-home-set')
    if (!home) return { url: start, calendars: [] }

    return { url: home, calendars: await this.calendarsAt(home) }
  }

  /** Calendars directly under `url`; none (rather than an error) when the server
   *  will not list it, so discovery can move on. A 401 still throws. */
  private async calendarsAt(url: string): Promise<CalDavCalendarDescriptor[]> {
    const res = await this.propfind(url, '1', `<D:resourcetype/>
    <D:displayname/>
    <I:calendar-color/>
    <CS:getctag/>
    <D:current-user-privilege-set/>`)
    if (!res) return []
    return parseCalDavMultistatus(await readTextWithin(res, res.url || url, MAX_DISCOVERY_BYTES), res.url || url)
  }

  /** The absolute href a single property on `url` points at, if the server has it. */
  private async propHref(url: string, prop: 'current-user-principal' | 'calendar-home-set'): Promise<string | undefined> {
    const res = await this.propfind(url, '0', prop === 'calendar-home-set' ? '<C:calendar-home-set/>' : '<D:current-user-principal/>')
    if (!res) return undefined
    const href = extractPropHref(await readTextWithin(res, res.url || url, MAX_DISCOVERY_BYTES), prop)
    return href ? resolveDavHref(href, res.url || url) : undefined
  }

  /** PROPFIND, or null for the statuses that just mean "not here". */
  private async propfind(url: string, depth: '0' | '1', props: string): Promise<Response | null> {
    const res = await this.request(
      url,
      'PROPFIND',
      `<?xml version="1.0" encoding="utf-8" ?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/" xmlns:I="http://apple.com/ns/ical/">
  <D:prop>
    ${props}
  </D:prop>
</D:propfind>`,
      { Depth: depth, 'Content-Type': 'application/xml; charset=utf-8' }
    )
    if (res.status === 401) {
      throw new Error(`CalDAV discovery failed with HTTP 401: ${await failureText(res)}`)
    }
    if (res.status === 207 || res.ok) return res
    if ([403, 404, 405, 501].includes(res.status)) return null
    throw new Error(`CalDAV discovery failed with HTTP ${res.status}: ${await failureText(res)}`)
  }

  /**
   * Pull all ICS events from a calendar collection via CalDAV REPORT
   */
  async pullCalendarEvents(calendarUrl: string): Promise<{ rawIcsList: (CalDavItem & { ics: string })[] }> {
    const items = await this.calendarQuery(calendarUrl, true, 'VEVENT')
    return { rawIcsList: items.filter((i): i is CalDavItem & { ics: string } => Boolean(i.ics)) }
  }

  async pullCalendarTasks(calendarUrl: string): Promise<CalDavItem[]> {
    return this.calendarQuery(calendarUrl, true, 'VTODO')
  }

  async readTaskResource(href: string): Promise<CalDavItem & { ics: string }> {
    const res = await this.request(href, 'GET', undefined, { Accept: 'text/calendar' })
    if (!res.ok) throw new CalDavTaskResourceError(res.status)
    return {
      href,
      ics: await readTextWithin(res, href, MAX_DISCOVERY_BYTES),
      etag: res.headers.get('ETag') ?? undefined
    }
  }

  /**
   * Every event resource in the calendar with its etag, and no data: a few
   * hundred KB for a calendar whose data runs to megabytes. Comparing the etags
   * with the stored ones says which resources need downloading at all.
   */
  async listEventEtags(calendarUrl: string): Promise<{ href: string; etag?: string }[]> {
    return (await this.calendarQuery(calendarUrl, false, 'VEVENT')).map(({ href, etag }) => ({ href, etag }))
  }

  /**
   * Download the named resources (absolute hrefs, as listed) with a
   * calendar-multiget, MULTIGET_BATCH at a time. A resource deleted since it was
   * listed is simply missing from the result. Returns null when the server will
   * not do a multiget, so the caller can fall back to the full query.
   */
  async fetchEvents(calendarUrl: string, hrefs: string[]): Promise<CalDavItem[] | null> {
    const items: CalDavItem[] = []
    const origin = new URL(calendarUrl).origin

    for (let i = 0; i < hrefs.length; i += MULTIGET_BATCH) {
      const refs = hrefs.slice(i, i + MULTIGET_BATCH).map((href) => {
        // Servers expect the path they listed; another host's resource keeps its full URL.
        const url = new URL(href)
        return `  <D:href>${escapeXml(url.origin === origin ? url.pathname : href)}</D:href>`
      })
      const body = `<?xml version="1.0" encoding="utf-8" ?>
<C:calendar-multiget xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag/>
    <C:calendar-data/>
  </D:prop>
${refs.join('\n')}
</C:calendar-multiget>`

      const res = await this.request(calendarUrl, 'REPORT', body, {
        Depth: '1',
        'Content-Type': 'application/xml; charset=utf-8'
      })
      if ([400, 403, 405, 415, 501].includes(res.status)) return null
      if (!res.ok && res.status !== 207) {
        throw new Error(`CalDAV multiget failed with HTTP ${res.status}: ${await failureText(res)}`)
      }
      const xml = await readTextWithin(res, calendarUrl, MAX_REPORT_BYTES, REPORT_BODY_TIMEOUT_MS)
      // As in eventQuery: no multistatus, no word on any resource asked for.
      if (!isMultistatus(xml)) {
        throw new Error(`CalDAV multiget got HTTP ${res.status} without a multistatus answer`)
      }
      items.push(...parseCalendarItems(xml, res.url || calendarUrl).filter((item) => item.ics))
    }

    return items
  }

  private async calendarQuery(calendarUrl: string, withData: boolean, component: 'VEVENT' | 'VTODO'): Promise<CalDavItem[]> {
    const reportXml = `<?xml version="1.0" encoding="utf-8" ?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag/>${withData ? '\n    <C:calendar-data/>' : ''}
  </D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="${component}"/>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`

    const res = await this.request(calendarUrl, 'REPORT', reportXml, {
      Depth: '1',
      'Content-Type': 'application/xml; charset=utf-8'
    })

    if (!res.ok && res.status !== 207) {
      if (component === 'VEVENT') {
        throw new Error(`CalDAV event query failed with HTTP ${res.status}: ${await failureText(res)}`)
      }
      throw new CalDavQueryError(res.status, component)
    }

    // The request's deadline ends with the headers, and a server on a flaky link
    // can stall mid-body; that would hold SyncWorker.isSyncing for good.
    const xml = await readTextWithin(res, calendarUrl, MAX_REPORT_BYTES, REPORT_BODY_TIMEOUT_MS)
    // A 2xx that is not a multistatus - a captive portal's page, a proxy's, a
    // server answering empty on a fault - listed no events, and the pull took
    // that as every event deleted on the server and removed them all here.
    if (!isMultistatus(xml)) {
      throw new Error(`CalDAV ${component === 'VEVENT' ? 'event' : 'task'} query got HTTP ${res.status} without a multistatus answer`)
    }
    return parseCalendarItems(xml, res.url || calendarUrl)
  }

  /**
   * Push an event to CalDAV collection via PUT. With the server's copy of it,
   * what other clients stored there and xrncal does not model is carried over
   * (mergeServerCopy); `body` is what was sent, the server's copy from now on.
   */
  async pushEvent(
    calendar: Calendar,
    event: CalendarEvent,
    exceptions: EventException[] = [],
    serverCopy?: { ics: string; keepAttendees: boolean }
  ): Promise<{ success: boolean; etag?: string; href?: string; conflict?: boolean; body?: string }> {
    // A CalDAV series lives in one resource, so per-occurrence overrides and
    // cancellations have to travel with the master as RECURRENCE-ID components;
    // omitting them silently strips the occurrence edit from the push.
    const generated = generateIcs(calendar, [event], exceptions)
    let icsContent = generated.replace('\r\nMETHOD:PUBLISH\r\n', '\r\n')
    if (serverCopy) {
      try {
        icsContent = mergeServerCopy(generated, serverCopy.ics, {
          tzid: event.tzid,
          reminders: event.reminders,
          keepAttendees: serverCopy.keepAttendees
        })
      } catch {
        // A copy that will not parse is no reason to hold the edit back.
      }
    }
    const eventUrl = event.providerEventId || eventUrlFor(calendar.id, event.uid || event.id)

    const headers: Record<string, string> = {
      'Content-Type': 'text/calendar; charset=utf-8'
    }
    if (event.etag) {
      headers['If-Match'] = event.etag
    }

    const res = await this.request(eventUrl, 'PUT', icsContent, headers)

    if (!res.ok && res.status !== 201 && res.status !== 204) {
      if (res.status === 412) {
        return { success: false, conflict: true }
      }
      throw new Error(`CalDAV PUT failed: HTTP ${res.status}`)
    }

    const newEtag = res.headers.get('ETag') || undefined
    return { success: true, etag: newEtag, href: eventUrl, body: icsContent }
  }

  /** PUT a resource as written, optionally requiring a matching ETag or a new URL. */
  async putIcs(
    href: string,
    ics: string,
    condition?: { ifMatch: string } | { ifNoneMatch: '*' }
  ): Promise<{ success: boolean; etag?: string; conflict?: boolean }> {
    const create = condition && 'ifNoneMatch' in condition
    const res = await this.request(href, 'PUT', ics, {
      'Content-Type': 'text/calendar; charset=utf-8',
      ...(condition && ('ifMatch' in condition
        ? { 'If-Match': condition.ifMatch }
        : { 'If-None-Match': condition.ifNoneMatch }))
    }, create ? 'error' : undefined)
    if (res.status === 412) return { success: false, conflict: true }
    if (!res.ok) throw new Error(`CalDAV PUT failed: HTTP ${res.status}`)
    return { success: true, etag: res.headers.get('ETag') || undefined }
  }

  async moveTaskResource(href: string, destination: string, etag: string): Promise<'moved' | 'conflict' | 'unsupported'> {
    const res = await this.request(href, 'MOVE', undefined, {
      Destination: destination, Overwrite: 'F', 'If-Match': etag
    }, 'error')
    if (res.status === 412) return 'conflict'
    if (res.status === 405 || res.status === 501) return 'unsupported'
    if (res.status === 201 || res.status === 204) return 'moved'
    throw new Error(`CalDAV MOVE failed: HTTP ${res.status}`)
  }

  /**
   * Delete an event from CalDAV collection via DELETE. `href` is where the
   * server keeps it; without one the UID-named address xrncal itself uses.
   * With `etag`, only that version is deleted: 'conflict' when the server has
   * another - edited on another device since it was read here.
   */
  async deleteEvent(calendarUrl: string, eventUid: string, href?: string, etag?: string): Promise<boolean | 'conflict'> {
    return this.deleteResource(href || eventUrlFor(calendarUrl, eventUid), etag)
  }

  async deleteResource(href: string, etag?: string, redirect?: RequestRedirect): Promise<boolean | 'conflict'> {
    const res = await this.request(
      href,
      'DELETE',
      undefined,
      etag ? { 'If-Match': etag } : {},
      redirect
    )
    if (res.status === 412) return 'conflict'
    return res.ok || res.status === 404
  }

  /**
   * Set a calendar's colour on the server: Apple's calendar-color, which the
   * other CalDAV clients read, written as Apple writes it (`#RRGGBBFF`).
   * 'refused' when the server will not keep it - the request refused (403, 405,
   * 501) or the property (a 4xx propstat) - so the colour can stay on this
   * computer instead. Anything else that goes wrong throws, to be tried again.
   */
  async setCalendarColor(calendarUrl: string, color: string): Promise<'saved' | 'refused'> {
    const hex = normalizeCalendarColor(color)
    if (!hex) return 'refused'
    const res = await this.request(
      calendarUrl,
      'PROPPATCH',
      `<?xml version="1.0" encoding="utf-8" ?>
<D:propertyupdate xmlns:D="DAV:" xmlns:I="http://apple.com/ns/ical/">
  <D:set>
    <D:prop>
      <I:calendar-color>${hex.toUpperCase()}FF</I:calendar-color>
    </D:prop>
  </D:set>
</D:propertyupdate>`,
      { 'Content-Type': 'application/xml; charset=utf-8' }
    )
    if ([403, 405, 501].includes(res.status)) return 'refused'
    if (res.status === 207) {
      const xml = await readTextWithin(res, res.url || calendarUrl, MAX_DISCOVERY_BYTES)
      const status = propstatStatus(xml, 'calendar-color')
      if (status === undefined || (status >= 400 && status < 500)) return 'refused'
      if (status >= 200 && status < 300) return 'saved'
      throw new Error(`CalDAV PROPPATCH of calendar-color failed with ${status}`)
    }
    if (res.ok) return 'saved'
    throw new Error(`CalDAV PROPPATCH failed with HTTP ${res.status}: ${await failureText(res)}`)
  }

  /** The calendar's ctag as the server has it now (a Depth-0 PROPFIND), if it keeps one. */
  async readCtag(calendarUrl: string): Promise<string | undefined> {
    const res = await this.propfind(calendarUrl, '0', '<D:resourcetype/>\n    <CS:getctag/>')
    if (!res) return undefined
    const xml = await readTextWithin(res, res.url || calendarUrl, MAX_DISCOVERY_BYTES)
    return parseCalDavMultistatus(xml, res.url || calendarUrl)[0]?.ctag
  }
}

/**
 * Where xrncal puts an event it creates. Other clients name their resources as
 * they like - not necessarily after the UID - so an event that came from the
 * server is addressed by the href the server listed it under instead.
 *
 * The name is the UID where a server will take that as a name. An event made
 * by another program keeps its UID when it is moved to another calendar, and
 * that can be anything: "urn:uuid:..." has colons, which Radicale refuses in a
 * path (400 on every sync, so the event never moved), and a "/" would name a
 * resource in another collection. Such a UID gets a name made from its hash:
 * the same one every time, so a retry writes the same resource again.
 */
function eventUrlFor(calendarUrl: string, uid: string): string {
  return `${calendarUrl.replace(/\/+$/, '')}/${resourceNameFor(uid)}.ics`
}

/** Refused in a path by Radicale, or meaning something else to a server once the path is decoded. */
const UNSAFE_IN_RESOURCE_NAME = /[:'"*?,/\\<>|#%]/
const RESOURCE_NAME_MAX_BYTES = 180

/** A control character (C0, DEL or C1) anywhere in the text. */
function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true
  }
  return false
}

function resourceNameFor(uid: string): string {
  const usable =
    uid.length > 0 &&
    !UNSAFE_IN_RESOURCE_NAME.test(uid) &&
    !hasControlCharacter(uid) &&
    !uid.startsWith('.') &&
    !/[ .]$/.test(uid) &&
    Buffer.byteLength(uid, 'utf8') <= RESOURCE_NAME_MAX_BYTES
  return usable ? encodeURIComponent(uid) : createHash('sha256').update(uid, 'utf8').digest('hex').slice(0, 40)
}

/** The `response` elements of a REPORT multistatus, with absolute hrefs so they can be stored and PUT or DELETEd as-is. */
/** Whether a WebDAV body is a multistatus at all (an empty one included). */
function isMultistatus(xml: string): boolean {
  return /<(?:[a-zA-Z0-9_-]+:)?multistatus[\s/>]/.test(xml)
}

function parseCalendarItems(xml: string, baseUrl: string): CalDavItem[] {
  const items: CalDavItem[] = []
  for (const resp of multistatusResponses(xml)) {
    const href = extractXmlText(resp, 'href')
    if (!href) continue
    items.push({
      href: resolveDavHref(href, baseUrl),
      ics: extractXmlText(resp, 'calendar-data') || undefined,
      etag: extractXmlText(resp, 'getetag') || undefined
    })
  }
  return items
}

/**
 * The status a multistatus gives `prop` in its propstat, e.g. 200 or 403.
 * Each propstat is found from where the last one ended, as in
 * multistatusResponses: a lazy pattern over the whole text would go back to
 * the end for every opening tag that has no closing one.
 */
function propstatStatus(xml: string, prop: string): number | undefined {
  const open = /<(?:[a-zA-Z0-9_-]+:)?propstat[\s>]/gi
  const close = /<\/(?:[a-zA-Z0-9_-]+:)?propstat>/gi
  const named = new RegExp(`<(?:[a-zA-Z0-9_-]+:)?${prop}[\\s/>]`, 'i')
  for (let from = 0; ; ) {
    open.lastIndex = from
    const start = open.exec(xml)
    if (!start) return undefined
    close.lastIndex = open.lastIndex
    if (!close.exec(xml)) return undefined
    const block = xml.slice(start.index, close.lastIndex)
    from = close.lastIndex
    if (!named.test(block)) continue
    const status = /<(?:[a-zA-Z0-9_-]+:)?status>\s*HTTP\/[\d.]+\s+(\d{3})/i.exec(block)
    if (status) return Number(status[1])
  }
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
