import ICAL from 'ical.js'
import { DateTime } from 'luxon'
import { MAX_REMINDER_MINUTES } from '@shared/reminders'
import type { TaskDetails } from '@shared/task-model'

export function writeNewTaskIcs(uid: string, details: TaskDetails): string {
  const calendar = new ICAL.Component('vcalendar')
  calendar.addPropertyWithValue('version', '2.0')
  calendar.addPropertyWithValue('prodid', '-//xrncal//Desktop Calendar//EN')
  const task = new ICAL.Component('vtodo')
  calendar.addSubcomponent(task)
  const now = ICAL.Time.fromJSDate(new Date(), true)
  task.addPropertyWithValue('uid', uid)
  task.addPropertyWithValue('dtstamp', now)
  task.addPropertyWithValue('created', now)
  task.addPropertyWithValue('summary', details.title)
  task.addPropertyWithValue('status', 'NEEDS-ACTION')
  task.addPropertyWithValue('percent-complete', 0)
  writeDeadline(task, details.dueDate, details.dueTime)
  writeTaskNotesAndReminders(task, details)
  return `${calendar.toString()}\r\n`
}

/** A resource may contain the master and exceptions of a recurring task. */
export function readTaskIcs(ics: string) {
  const calendar = new ICAL.Component(ICAL.parse(ics))
  const tasks = calendar.getAllSubcomponents('vtodo')
  const task = tasks.find((item) => !item.hasProperty('recurrence-id')) ?? tasks[0]
  const uid = task?.getFirstPropertyValue('uid')
  if (!task || typeof uid !== 'string' || !uid) return null

  const status = task.getFirstPropertyValue('status')
  const complete = task.getFirstPropertyValue('percent-complete') ?? task.getFirstPropertyValue('percent_complete')
  const due = readDeadline(task)
  return {
    calendar,
    task,
    uid,
    title: String(task.getFirstPropertyValue('summary') ?? ''),
    ...due,
    description: String(task.getFirstPropertyValue('description') ?? ''),
    reminderMinutes: Array.from(new Set(task.getAllSubcomponents('valarm').flatMap((alarm) => {
      const minutes = reminderOffset(alarm)
      return minutes === undefined ? [] : [minutes]
    }))).sort((a, b) => a - b),
    completed: status === 'COMPLETED' || Number(complete) === 100 || task.hasProperty('completed'),
    readOnly: status === 'CANCELLED' || tasks.length > 1 || task.hasProperty('rrule') ||
      task.hasProperty('rdate') || task.hasProperty('recurrence-id')
  }
}

export function writeTaskCompletion(copy: NonNullable<ReturnType<typeof readTaskIcs>>, completed: boolean): string {
  const now = ICAL.Time.fromJSDate(new Date(), true)
  const percent = completed ? 100 : 0
  copy.task.updatePropertyWithValue('status', completed ? 'COMPLETED' : 'NEEDS-ACTION')
  copy.task.updatePropertyWithValue('percent-complete', percent)
  // Some Synology task resources carry this extra spelling alongside the standard property.
  if (copy.task.hasProperty('percent_complete')) {
    copy.task.updatePropertyWithValue('percent_complete', String(percent))
  }
  if (completed) copy.task.updatePropertyWithValue('completed', now)
  else copy.task.removeAllProperties('completed')
  return serializeEdit(copy, now)
}

export function writeTaskDetails(
  copy: NonNullable<ReturnType<typeof readTaskIcs>>,
  details: TaskDetails
): string {
  copy.task.updatePropertyWithValue('summary', details.title)
  const dueTime = !details.dueDate ? undefined
    : details.dueTime === undefined ? copy.dueTime : details.dueTime ?? undefined
  if (details.dueDate !== copy.dueDate || dueTime !== copy.dueTime) {
    writeDeadline(copy.task, details.dueDate, dueTime)
  }
  writeTaskNotesAndReminders(copy.task, details)
  if (copy.dueDate && !details.dueDate && copy.task.getAllSubcomponents('valarm').some(isEndAlarm)) {
    throw new Error('Remove the deadline reminders before clearing the due date')
  }
  return serializeEdit(copy, ICAL.Time.fromJSDate(new Date(), true))
}

function readDeadline(task: ICAL.Component): { dueDate?: string; dueTime?: string } {
  const prop = task.getFirstProperty('due')
  const due = prop?.getFirstValue()
  if (!(due instanceof ICAL.Time)) return {}
  const iso = due.toString()
  if (due.isDate) return { dueDate: iso }
  const tzid = prop?.getParameter('tzid')
  const dateTime = DateTime.fromISO(iso, typeof tzid === 'string' ? { zone: tzid } : {})
  const local = dateTime.isValid ? dateTime.toLocal().toISO()! : iso
  return { dueDate: local.slice(0, 10), dueTime: local.slice(11, 16) }
}

function writeDeadline(task: ICAL.Component, date?: string, time?: string | null): void {
  if (!date) {
    task.removeAllProperties('due')
    return
  }
  const value = time
    ? ICAL.Time.fromJSDate(DateTime.fromISO(`${date}T${time}`).toJSDate(), true)
    : ICAL.Time.fromDateString(date)
  const start = task.getFirstPropertyValue('dtstart')
  if (start instanceof ICAL.Time && start.isDate !== value.isDate) {
    throw new Error('The deadline and existing start must both be dates or both include a time')
  }
  if (start instanceof ICAL.Time && value.compare(start) < 0) {
    throw new Error('The deadline must not precede the task’s start')
  }
  task.removeAllProperties('due')
  task.removeAllProperties('duration')
  task.addPropertyWithValue('due', value)
}

function isEndAlarm(alarm: ICAL.Component): boolean {
  return String(alarm.getFirstProperty('trigger')?.getParameter('related') ?? '').toUpperCase() === 'END'
}

function reminderOffset(alarm: ICAL.Component): number | undefined {
  if (!isEndAlarm(alarm) || String(alarm.getFirstPropertyValue('action')).toUpperCase() !== 'DISPLAY' ||
    alarm.hasProperty('repeat') || alarm.hasProperty('duration')) return undefined
  const trigger = alarm.getFirstPropertyValue('trigger')
  if (!(trigger instanceof ICAL.Duration)) return undefined
  const minutes = -(trigger.toSeconds() || 0) / 60
  return Number.isInteger(minutes) && minutes >= 0 && minutes <= MAX_REMINDER_MINUTES ? Math.abs(minutes) : undefined
}

function writeTaskNotesAndReminders(task: ICAL.Component, details: TaskDetails): void {
  if (details.description === '') task.removeAllProperties('description')
  else if (details.description !== undefined) task.updatePropertyWithValue('description', details.description)
  if (!details.reminderMinutes) return
  if (details.reminderMinutes.length && !task.hasProperty('due')) throw new Error('Reminders need a due date')
  const remaining = new Set(details.reminderMinutes)
  for (const alarm of task.getAllSubcomponents('valarm')) {
    const minutes = reminderOffset(alarm)
    if (minutes !== undefined && !remaining.delete(minutes)) task.removeSubcomponent(alarm)
  }
  for (const minutes of remaining) {
    const alarm = new ICAL.Component('valarm')
    alarm.addPropertyWithValue('action', 'DISPLAY')
    alarm.addPropertyWithValue('description', details.title)
    const trigger = new ICAL.Property('trigger')
    trigger.setParameter('related', 'END')
    trigger.setValue(ICAL.Duration.fromSeconds(-minutes * 60))
    alarm.addProperty(trigger)
    task.addSubcomponent(alarm)
  }
}

function serializeEdit(copy: NonNullable<ReturnType<typeof readTaskIcs>>, now: ICAL.Time): string {
  copy.task.updatePropertyWithValue('last-modified', now)
  copy.task.updatePropertyWithValue('dtstamp', now)
  return `${copy.calendar.toString()}\r\n`
}
