import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-contract'
import { CHINA_CALENDAR_URL, HOLIDAY_CALENDAR_META, type HolidayCalendarOption } from '../../shared/holiday-calendars'
import { getDatabase } from '../db/database'
import { CalendarsRepo } from '../db/repos/calendars-repo'
import { countCalendarEvents, removeCalendar } from '../db/repos/remove-calendar'
import { subscribeHolidayCalendar, unsubscribeHolidayCalendar } from '../holidays/holiday-subscription'
import { addSubscription } from '../subscriptions/ics-subscription'

export function registerHolidayIpcHandlers(): void {
  ipcMain.removeHandler(IPC_CHANNELS.HOLIDAYS.SUBSCRIBE)
  ipcMain.removeHandler(IPC_CHANNELS.HOLIDAYS.UNSUBSCRIBE)

  ipcMain.handle(IPC_CHANNELS.HOLIDAYS.SUBSCRIBE, async (_event, type: HolidayCalendarOption) => {
    const db = getDatabase()
    if (type === 'china') {
      const calendar = await addSubscription(db, CHINA_CALENDAR_URL, '中国日历', { reuseExisting: true })
      return { calendarId: calendar.id, count: countCalendarEvents(db, calendar.id) }
    }
    if (!Object.hasOwn(HOLIDAY_CALENDAR_META, type)) throw new Error('Unknown holiday calendar')
    return subscribeHolidayCalendar(db, type)
  })

  ipcMain.handle(IPC_CHANNELS.HOLIDAYS.UNSUBSCRIBE, async (_event, type: HolidayCalendarOption) => {
    const db = getDatabase()
    if (type === 'china') {
      const calendar = new CalendarsRepo(db).listCalendars().find((entry) => entry.subscriptionUrl === CHINA_CALENDAR_URL)
      return calendar ? removeCalendar(db, calendar.id) : false
    }
    if (!Object.hasOwn(HOLIDAY_CALENDAR_META, type)) throw new Error('Unknown holiday calendar')
    return unsubscribeHolidayCalendar(db, type)
  })
}
