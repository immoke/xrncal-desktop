import { createServer, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { expect, test, type Page } from '@playwright/test'
import { launchApp } from './app'

const home = '/caldav.php/task-test/'
const list = `${home}home_todo/`
const href = `${list}sample.ics`
const recurringHref = `${list}weekly.ics`
const custom = `${home}team/`
const otherHome = '/other-server/caldav.php/task-test/'
const otherList = `${otherHome}home_todo/`
const calendarHome = '/calendar-server/dav/'
const categoryId = '/task-test/team/'
const newCategory = 'Team "计划" + 1'
const renamedCategory = 'Project "清单"'
const categoryFlags = [
  'is_hidden_in_cal', 'is_hidden_in_list',
  'notify_alarm_by_browser', 'notify_alarm_by_mail',
  'notify_evt_by_browser', 'notify_evt_by_mail',
  'notify_import_cal_by_browser', 'notify_import_cal_by_mail'
]
const auth = `Basic ${Buffer.from('task-test:fixture-only').toString('base64')}`
const initial = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//xrncal//Local fixture//EN',
  'BEGIN:VTODO', 'UID:test-task', 'DTSTAMP:20220901T100000Z', 'DUE;VALUE=DATE:20220901',
  'SUMMARY:Existing NAS task', 'DESCRIPTION:Keep other fields', 'X-NAS-TEST:value',
  'STATUS:NEEDS-ACTION', 'PERCENT-COMPLETE:0', 'PERCENT_COMPLETE:0',
  'END:VTODO', 'END:VCALENDAR', ''
].join('\r\n')
const recurring = initial.replace('UID:test-task', 'UID:weekly-task')
  .replace('SUMMARY:Existing NAS task', 'SUMMARY:Weekly task\r\nDTSTART;VALUE=DATE:20220831\r\nRRULE:FREQ=WEEKLY')

function xml(response: ServerResponse, body = '') {
  response.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' })
  response.end(`<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:I="http://apple.com/ns/ical/">${body}</D:multistatus>`)
}

function collection(url: string, name: string, component: string, color = '#4477AA') {
  return `<D:response><D:href>${url}</D:href><D:propstat><D:prop>
    <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
    <D:displayname>${name}</D:displayname>
    <I:calendar-color>${color}</I:calendar-color>
    <C:supported-calendar-component-set><C:comp name="${component}"/></C:supported-calendar-component-set>
    <D:current-user-privilege-set><D:privilege><D:write/></D:privilege></D:current-user-privilege-set>
    </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
}

function resource(url: string, etag: string, body: string) {
  return `<D:response><D:href>${url}</D:href><D:propstat><D:prop><D:getetag>${etag}</D:getetag>
    <C:calendar-data><![CDATA[${body}]]></C:calendar-data></D:prop><D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat></D:response>`
}

async function addTaskServer(page: Page, name: string, address: string) {
  await page.getByRole('button', { name: 'Add task server', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Add task server' })
  await dialog.getByLabel('Display name').fill(name)
  await dialog.getByLabel('Synology address').fill(address)
  await dialog.getByLabel('Username').fill('task-test')
  await dialog.getByLabel('Password').fill('fixture-only')
  await dialog.getByRole('button', { name: 'Save server' }).click()
  await expect(dialog).toHaveCount(0)
}

test('reads an existing task and confirms complete and reopen through CalDAV', async ({ request: web }, testInfo) => {
  let ics = initial
  let revision = 1
  let writes = 0
  let taskRequests = 0
  let otherTaskRequests = 0
  let wrongWorkspaceRequests = 0
  let category: { cal_displayname: string; cal_color: string } | null = null
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = Buffer.concat(chunks).toString()
    const etag = `"${revision}"`
    const path = request.url ?? ''
    if (path === '/webapi/entry.cgi' && request.method === 'POST') {
      const params = new URLSearchParams(body)
      const method = params.get('method')
      const reply = (data?: unknown) => {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ success: true, data }))
      }
      const invalidParameters = () => {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ success: false, error: { code: 9009 } }))
      }
      const jsonString = (key: string): string | undefined => {
        try {
          const value: unknown = JSON.parse(params.get(key) ?? 'null')
          return typeof value === 'string' ? value : undefined
        } catch {
          return undefined
        }
      }
      if (params.get('api') === 'SYNO.API.Auth' && method === 'login' &&
        params.get('account') === 'task-test' && params.get('passwd') === 'fixture-only') {
        reply({ sid: 'fixture-session', synotoken: 'fixture-token' })
        return
      }
      if (params.get('_sid') !== 'fixture-session' || request.headers['x-syno-token'] !== 'fixture-token') {
        response.writeHead(401).end()
        return
      }
      if (method === 'logout') { reply(); return }
      if (params.get('api') === 'SYNO.Cal.Cal') {
        if (params.get('version') !== '5') { invalidParameters(); return }
        if (method === 'list') {
          if (jsonString('cal_type') !== 'todo') { invalidParameters(); return }
          reply({ list: category ? [{
            ...category, cal_type: 'todo', cal_id: categoryId, original_cal_id: categoryId,
            cal_privilege: 'RW', cal_description: 'Keep me', notify_alarm_by_browser: false
          }] : [] })
          return
        }
        if (method === 'create' || method === 'set') {
          const name = jsonString('cal_displayname')
          const color = jsonString('cal_color')
          const description = jsonString('cal_description')
          if (jsonString('cal_type') !== 'todo' || !name || !color || !/^#[0-9A-F]{6}$/.test(color) ||
              !categoryFlags.every((flag) => ['true', 'false'].includes(params.get(flag) ?? '')) ||
              (method === 'create' && description !== '') ||
              (method === 'set' && (description !== 'Keep me' || jsonString('cal_id') !== categoryId ||
                jsonString('original_cal_id') !== categoryId || params.get('notify_alarm_by_browser') !== 'false'))) {
            invalidParameters()
            return
          }
          category = { cal_displayname: name, cal_color: color }
          reply(category)
          return
        }
        if (method === 'delete') {
          if (jsonString('cal_id') !== categoryId) { invalidParameters(); return }
          category = null
          reply()
          return
        }
      }
      response.writeHead(400).end()
      return
    }
    if (request.headers.authorization !== auth) {
      response.writeHead(401).end()
      return
    }
    if (path === calendarHome.slice(0, -1) || path.startsWith(calendarHome)) {
      if (request.method === 'PROPFIND') xml(response, collection(`${calendarHome}calendar/`, 'Calendar only', 'VEVENT'))
      else {
        if (body.includes('name="VTODO"')) wrongWorkspaceRequests++
        xml(response)
      }
      return
    }
    if (path === otherHome.slice(0, -1) || path.startsWith(otherHome)) {
      if (request.method === 'PROPFIND') xml(response,
        collection(otherList, 'Other inbox', 'VTODO') + collection(`${otherHome}calendar/`, 'Other calendar', 'VEVENT'))
      else if (request.method === 'REPORT' && body.includes('name="VTODO"')) {
        otherTaskRequests++
        xml(response, resource(`${otherList}other.ics`, '"other"', initial.replace('Existing NAS task', 'Other server task')))
      } else {
        if (body.includes('name="VEVENT"')) wrongWorkspaceRequests++
        xml(response)
      }
      return
    }
    if (request.method === 'PROPFIND') {
      xml(response, collection(list, 'Inbox test', 'VTODO') + collection(`${home}calendar/`, 'Calendar', 'VEVENT') +
        (category ? collection(custom, category.cal_displayname, 'VTODO', category.cal_color) : ''))
      return
    }
    if (request.method === 'REPORT') {
      if (body.includes('name="VTODO"')) {
        taskRequests++
        if (path === custom && category) { xml(response); return }
        if (request.url !== list) {
          response.writeHead(404).end()
          return
        }
        xml(response, resource(href, etag, ics) + resource(recurringHref, '"recurring"', recurring))
      } else {
        if (body.includes('name="VEVENT"')) wrongWorkspaceRequests++
        xml(response)
      }
      return
    }
    if (request.method === 'GET' && request.url === href) {
      response.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8', ETag: etag })
      response.end(ics)
      return
    }
    if (request.method === 'PUT' && request.url === href) {
      if (request.headers['if-match'] !== etag) {
        response.writeHead(412).end()
        return
      }
      writes++
      ics = body
      response.writeHead(204, { ETag: `"${++revision}"` }).end()
      return
    }
    response.writeHead(['MKCALENDAR', 'PROPPATCH', 'DELETE'].includes(request.method ?? '') ? 405 : 404).end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test server address')
  const origin = `http://127.0.0.1:${address.port}`

  try {
    const running = await launchApp()
    try {
      const { page } = running
      const connected = await page.evaluate(async (url) => window.xrncal?.auth.connectCalDav({
        provider: 'generic', serverUrl: url, username: 'task-test', password: 'fixture-only', name: 'Calendar test server'
      }), origin + calendarHome)
      expect(connected?.success, connected?.message).toBe(true)
      await page.reload()
      await expect(page.getByText('Calendar only', { exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'Sync an account or subscription' }).click()
      await expect(page.getByRole('banner').getByRole('button', { name: 'Calendar test server' })).toBeVisible()
      await page.keyboard.press('Escape')
      await page.getByRole('banner').getByRole('button', { name: 'Calendar', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Tasks', exact: true }).click()
      await expect(page.getByText('Add a Synology task server to view its tasks.')).toBeVisible()
      expect(taskRequests).toBe(0)
      await addTaskServer(page, 'NAS test', origin + home)
      const task = page.getByRole('checkbox', { name: 'Existing NAS task' })
      await expect(task).toBeEnabled()
      await expect(page.getByText(/Overdue/).first()).toBeVisible()
      await expect(page.getByRole('checkbox', { name: 'Weekly task' })).toBeDisabled()
      await expect(page.getByRole('button', { name: 'Inbox test', exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Previous month' })).toBeVisible()
      await page.getByRole('button', { name: 'Collapse sidebar' }).click()
      await expect(page.getByRole('button', { name: 'Inbox test', exact: true })).toHaveCount(0)
      await page.getByRole('button', { name: 'Expand sidebar' }).click()
      await expect(page.getByRole('button', { name: 'Inbox test', exact: true })).toBeVisible()
      await page.screenshot({ path: testInfo.outputPath('task-view.png') })

      await task.click()
      await expect(task).toHaveCount(0)
      await page.getByRole('button', { name: /^Completed/ }).click()
      await expect(task).toBeChecked()
      const completed = await web.get(origin + href, { headers: { Authorization: auth } }).then((res) => res.text())
      expect(completed).toContain('STATUS:COMPLETED')
      expect(completed).toContain('PERCENT-COMPLETE:100')
      expect(completed).toContain('PERCENT_COMPLETE:100')
      expect(completed).toMatch(/COMPLETED:\d{8}T\d{6}Z/)
      expect(completed).toContain('X-NAS-TEST:value')

      await task.click()
      await expect(task).toHaveCount(0)
      await page.getByRole('button', { name: /^To do/ }).click()
      await expect(task).not.toBeChecked()
      const reopened = await web.get(origin + href, { headers: { Authorization: auth } }).then((res) => res.text())
      expect(reopened).toContain('STATUS:NEEDS-ACTION')
      expect(reopened).toContain('PERCENT-COMPLETE:0')
      expect(reopened).not.toMatch(/\r?\nCOMPLETED:/)
      expect(reopened).toContain('DESCRIPTION:Keep other fields')

      ics = ics.replace('Keep other fields', 'Changed from another client')
      revision++
      await task.click()
      await expect(page.getByRole('alert')).toContainText('changed on the server')
      expect(writes).toBe(2)
      expect(ics).toContain('Changed from another client')
      await page.getByRole('button', { name: 'Sync now', exact: true }).click()
      await expect(task).toBeEnabled()
      await expect(task).not.toBeChecked()

      await page.getByRole('button', { name: 'New category' }).click()
      let dialog = page.getByRole('dialog', { name: 'New category' })
      await dialog.getByLabel('Category name').fill(newCategory)
      await dialog.getByLabel('Colour').fill('#aabbcc')
      await dialog.getByRole('button', { name: 'Save category' }).click()
      await expect(page.getByRole('button', { name: newCategory, exact: true })).toBeVisible()
      expect(category).toEqual({ cal_displayname: newCategory, cal_color: '#AABBCC' })

      await page.getByRole('button', { name: `Options for ${newCategory}` }).click()
      await page.getByRole('menuitem', { name: 'Edit category' }).click()
      dialog = page.getByRole('dialog', { name: 'Edit category' })
      await dialog.getByLabel('Category name').fill(renamedCategory)
      await dialog.getByLabel('Colour').fill('#aa33cc')
      await dialog.getByRole('button', { name: 'Save category' }).click()
      await expect(page.getByRole('button', { name: renamedCategory, exact: true })).toBeVisible()
      expect(category).toEqual({ cal_displayname: renamedCategory, cal_color: '#AA33CC' })

      await page.getByRole('button', { name: `Options for ${renamedCategory}` }).click()
      await page.getByRole('menuitem', { name: 'Delete category' }).click()
      dialog = page.getByRole('dialog', { name: 'Delete category' })
      await dialog.getByRole('button', { name: 'Cancel' }).click()
      expect(category).not.toBeNull()
      await page.getByRole('button', { name: `Options for ${renamedCategory}` }).click()
      await page.getByRole('menuitem', { name: 'Delete category' }).click()
      await dialog.getByRole('button', { name: 'Delete', exact: true }).click()
      await expect(page.getByRole('button', { name: renamedCategory, exact: true })).toHaveCount(0)
      expect(category).toBeNull()

      await page.getByRole('button', { name: 'Task servers', exact: true }).click()
      await addTaskServer(page, 'Second test NAS', origin + otherHome)
      await expect(page.getByRole('checkbox', { name: 'Other server task' })).toBeEnabled()
      await page.getByRole('button', { name: 'Task servers', exact: true }).click()
      await page.getByRole('button', { name: 'Edit server Second test NAS' }).click()
      const editServer = page.getByRole('dialog', { name: 'Edit task server' })
      await editServer.getByLabel('Display name').fill('Other test server')
      await expect(editServer.getByLabel('Password')).toBeEmpty()
      await editServer.getByRole('button', { name: 'Save server' }).click()
      await expect(editServer).toHaveCount(0)
      await expect(page.getByRole('checkbox', { name: 'Other server task' })).toBeEnabled()
      const beforeTargetedSync = taskRequests
      const beforeOtherTargetedSync = otherTaskRequests
      await page.getByRole('button', { name: 'Sync a server' }).click()
      await expect(page.getByRole('button', { name: 'Calendar test server' })).toHaveCount(0)
      await page.getByRole('button', { name: 'NAS test', exact: true }).click()
      await expect(task).toBeEnabled()
      expect(taskRequests).toBe(beforeTargetedSync + 1)
      expect(otherTaskRequests).toBe(beforeOtherTargetedSync)
      await page.getByRole('button', { name: 'Sync a server' }).click()
      await page.getByRole('button', { name: 'Other test server', exact: true }).click()
      await expect(page.getByRole('checkbox', { name: 'Other server task' })).toBeEnabled()
      expect(otherTaskRequests).toBe(beforeOtherTargetedSync + 1)
      expect(taskRequests).toBe(beforeTargetedSync + 1)

      await page.getByRole('banner').getByRole('button', { name: 'Tasks', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Calendar', exact: true }).click()
      await expect(page.getByRole('button', { name: 'Create', exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'Sync an account or subscription' }).click()
      await expect(page.getByRole('banner').getByRole('button', { name: 'Calendar test server' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'NAS test', exact: true })).toHaveCount(0)
      expect(wrongWorkspaceRequests).toBe(0)
      expect(running.errors).toEqual([])
    } finally {
      await running.close()
    }
  } finally {
    server.close()
    await once(server, 'close')
  }
})
