import ICAL from 'ical.js'
import type { TaskDetails } from '@shared/task-model'

export function writeNewTaskIcs(uid: string, { title, dueDate }: TaskDetails): string {
  const calendar = new ICAL.Component('vcalendar')
  calendar.addPropertyWithValue('version', '2.0')
  calendar.addPropertyWithValue('prodid', '-//xrncal//Desktop Calendar//EN')
  const task = new ICAL.Component('vtodo')
  calendar.addSubcomponent(task)
  const now = ICAL.Time.fromJSDate(new Date(), true)
  task.addPropertyWithValue('uid', uid)
  task.addPropertyWithValue('dtstamp', now)
  task.addPropertyWithValue('created', now)
  task.addPropertyWithValue('summary', title)
  task.addPropertyWithValue('status', 'NEEDS-ACTION')
  task.addPropertyWithValue('percent-complete', 0)
  if (dueDate) task.addPropertyWithValue('due', ICAL.Time.fromDateString(dueDate))
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
  const due = task.getFirstPropertyValue('due')
  return {
    calendar,
    task,
    uid,
    title: String(task.getFirstPropertyValue('summary') ?? ''),
    dueDate: due instanceof ICAL.Time ? due.toString().slice(0, 10) : undefined,
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
  { title, dueDate }: TaskDetails
): string {
  copy.task.updatePropertyWithValue('summary', title)
  if (dueDate !== copy.dueDate) {
    const existing = copy.task.getFirstProperty('due')
    const start = copy.task.getFirstProperty('dtstart')
    if (dueDate) {
      const date = ICAL.Time.fromDateString(dueDate)
      const template = existing ?? start
      const templateTime = template?.getFirstValue()
      const value = templateTime instanceof ICAL.Time && !templateTime.isDate
        ? ICAL.Time.fromData({
          year: date.year, month: date.month, day: date.day,
          hour: templateTime.hour, minute: templateTime.minute, second: templateTime.second, isDate: false
        }, templateTime.zone)
        : date
      const startTime = start?.getFirstValue()
      if (startTime instanceof ICAL.Time && value.compare(startTime) <= 0) {
        throw new Error('The due date must be after the task’s start')
      }
      const due = existing ?? new ICAL.Property('due')
      due.setValue(value)
      const tzid = template?.getParameter('tzid')
      if (typeof tzid === 'string') due.setParameter('tzid', tzid)
      if (!existing) copy.task.addProperty(due)
      copy.task.removeAllProperties('duration')
    } else {
      copy.task.removeAllProperties('due')
    }
  }
  return serializeEdit(copy, ICAL.Time.fromJSDate(new Date(), true))
}

function serializeEdit(copy: NonNullable<ReturnType<typeof readTaskIcs>>, now: ICAL.Time): string {
  copy.task.updatePropertyWithValue('last-modified', now)
  copy.task.updatePropertyWithValue('dtstamp', now)
  return `${copy.calendar.toString()}\r\n`
}
