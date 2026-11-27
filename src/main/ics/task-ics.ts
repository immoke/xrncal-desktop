import ICAL from 'ical.js'

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
  copy.task.updatePropertyWithValue('last-modified', now)
  copy.task.updatePropertyWithValue('dtstamp', now)
  return `${copy.calendar.toString()}\r\n`
}
