import { describe, expect, it } from 'vitest'
import { readTaskIcs, writeNewTaskIcs, writeTaskDetails } from '../src/main/ics/task-ics'

describe('task editor iCalendar fields', () => {
  it('round-trips a local time and keeps date-only and undated tasks available', () => {
    const details = {
      title: 'Plan, review', dueDate: '2026-12-01', dueTime: '22:00',
      description: 'First line\nSecond line', reminderMinutes: [0, 15]
    }
    const ics = writeNewTaskIcs('timed-task', details)
    expect(ics).toMatch(/DUE:\d{8}T\d{6}Z/)
    expect(readTaskIcs(ics)).toMatchObject(details)
    expect(writeNewTaskIcs('all-day-task', { title: 'Pick a day', dueDate: '2026-12-01' }))
      .toContain('DUE;VALUE=DATE:20261201')
    expect(writeNewTaskIcs('undated-task', { title: 'No due date' })).not.toContain('DUE')
  })

  it('preserves synced timezone, description and email alarms while editing title and display reminders', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VTODO',
      'UID:existing',
      'SUMMARY:Original',
      'DUE;TZID=Asia/Shanghai:20261201T223015',
      'DESCRIPTION:Existing details',
      'X-SYNO-EXAMPLE:Keep this',
      'BEGIN:VALARM',
      'ACTION:EMAIL',
      'TRIGGER;RELATED=END:-PT25M',
      'DESCRIPTION:Existing email',
      'END:VALARM',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'TRIGGER;RELATED=END:-PT15M',
      'DESCRIPTION:Existing display',
      'END:VALARM',
      'END:VTODO',
      'END:VCALENDAR',
      ''
    ].join('\r\n')
    const before = readTaskIcs(ics)!
    const updated = writeTaskDetails(before, {
      title: 'Edited', dueDate: before.dueDate, dueTime: before.dueTime, reminderMinutes: []
    })
    expect(updated).toContain('DUE;TZID=Asia/Shanghai:20261201T223015')
    expect(updated).toContain('DESCRIPTION:Existing details')
    expect(updated).toContain('X-SYNO-EXAMPLE:Keep this')
    expect(updated).toContain('TRIGGER;RELATED=END:-PT25M')
    expect(updated).not.toContain('TRIGGER;RELATED=END:-PT15M')
    expect(readTaskIcs(updated)).toMatchObject({ title: 'Edited', reminderMinutes: [] })
  })
})
