import { useCallback, useEffect, useRef, useState } from 'react'
import type { CalDavTask, CalDavTaskList, CalDavTaskListChange, CreateTaskInput, TaskDetails, TaskServer, TaskServerInput } from '@shared/task-model'

interface Snapshot {
  lists: CalDavTaskList[]
  error?: string
}

export function useTaskWorkspace(enabled: boolean) {
  const api = window.xrncal?.tasks
  const [sources, setSources] = useState<TaskServer[]>([])
  const [serversReady, setServersReady] = useState(false)
  const [serverError, setServerError] = useState('')
  const [selectedServer, setServer] = useState('')
  const [selectedListId, selectList] = useState('')
  const [snapshots, setSnapshots] = useState<Record<string, Snapshot>>({})
  const [syncing, setSyncing] = useState(false)
  const [saving, setSaving] = useState(false)
  const pending = useRef(false)
  const account = sources.find((item) => item.id === selectedServer) ?? sources[0]
  const id = account?.id
  const snapshot = id ? snapshots[id] : undefined
  const lists = snapshot?.lists ?? []
  const selectedList = lists.find((list) => list.id === selectedListId)

  const selectServer = useCallback((id: string) => {
    setServer(id)
    selectList('')
  }, [])

  useEffect(() => {
    if (!enabled || !api) return
    let live = true
    api.servers().then((servers) => {
      if (live) setSources(servers)
    }).catch((error: unknown) => {
      if (live) setServerError(error instanceof Error ? error.message : String(error))
    }).finally(() => {
      if (live) setServersReady(true)
    })
    return () => { live = false }
  }, [api, enabled])

  const readServers = useCallback(async (ids: string[]) => {
    if (!api) return
    await Promise.all(ids.map(async (accountId) => {
      try {
        const lists = await api.list(accountId)
        setSnapshots((current) => ({ ...current, [accountId]: { lists } }))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        setSnapshots((current) => ({
          ...current, [accountId]: { lists: current[accountId]?.lists ?? [], error: message }
        }))
      }
    }))
  }, [api])

  const sync = useCallback(async (sourceId?: string, select = true) => {
    if (!api || pending.current) return
    const ids = sourceId ? sources.filter((source) => source.id === sourceId).map((source) => source.id)
      : sources.map((source) => source.id)
    if (ids.length === 0) return
    pending.current = true
    if (sourceId && select && sourceId !== id) selectServer(sourceId)
    setSyncing(true)
    try {
      await readServers(ids)
    } finally {
      pending.current = false
      setSyncing(false)
    }
  }, [api, id, readServers, selectServer, sources])

  // Opening a task workspace loads the selected account. The toolbar can
  // then refresh one account or all connected CalDAV accounts on demand.
  useEffect(() => {
    if (!enabled || !id || snapshot || syncing || saving) return
    let live = true
    queueMicrotask(() => { if (live) void sync(id, false) })
    return () => { live = false }
  }, [enabled, id, saving, snapshot, sync, syncing])

  async function changeList(change: CalDavTaskListChange) {
    if (!id || !api || pending.current) throw new Error('Task server is busy')
    pending.current = true
    setSaving(true)
    try {
      await api.changeList(id, change)
      await readServers([id])
    } finally {
      pending.current = false
      setSaving(false)
    }
  }

  async function createTask(input: CreateTaskInput): Promise<CalDavTask> {
    if (!id || !api || pending.current) throw new Error('Task server is busy')
    pending.current = true
    setSaving(true)
    try {
      const task = await api.create(id, input)
      setSnapshots((current) => {
        const active = current[id]
        if (!active) return current
        const lists = active.lists.map((list) => list.id === input.listId
          ? { ...list, tasks: [...list.tasks.filter((entry) => entry.id !== task.id), task] }
          : list)
        return { ...current, [id]: { ...active, lists } }
      })
      return task
    } finally {
      pending.current = false
      setSaving(false)
    }
  }

  async function changeTask(taskId: string, details: TaskDetails | boolean | 'delete') {
    if (!id || !api || pending.current) throw new Error('Task server is busy')
    pending.current = true
    setSaving(true)
    try {
      const result = details === 'delete' ? await api.delete(id, taskId) : typeof details === 'boolean'
        ? await api.setCompleted(id, taskId, details)
        : await api.update(id, taskId, details)
      const status = typeof result === 'string' ? result : result.status
      if (status !== 'saved' && status !== 'deleted') return status
      const saved = typeof result !== 'string' && result.status === 'saved' ? result.task : null
      setSnapshots((current) => {
        const active = current[id]
        if (!active) return current
        const lists = active.lists.map((list) => ({
          ...list,
          tasks: saved ? list.tasks.map((item) => item.id === taskId ? saved : item)
            : list.tasks.filter((item) => item.id !== taskId)
        }))
        return { ...current, [id]: { lists } }
      })
      return status
    } finally {
      pending.current = false
      setSaving(false)
    }
  }

  async function saveServer(input: TaskServerInput) {
    if (!api || pending.current) throw new Error('Task server is busy')
    pending.current = true
    setSaving(true)
    try {
      const saved = await api.saveServer(input)
      setSources((current) => input.id ? current.map((item) => item.id === saved.id ? saved : item) : [...current, saved])
      setSnapshots((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== saved.id)))
      selectServer(saved.id)
    } finally {
      pending.current = false
      setSaving(false)
    }
  }

  async function removeServer(id: string) {
    if (!api || pending.current) throw new Error('Task server is busy')
    pending.current = true
    setSaving(true)
    try {
      await api.removeServer(id)
      setSources((current) => current.filter((item) => item.id !== id))
      setSnapshots((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== id)))
      if (account?.id === id) selectServer('')
    } finally {
      pending.current = false
      setSaving(false)
    }
  }

  return {
    sources, account, lists, selectedList, selectList, selectServer, sync, changeList, createTask, changeTask,
    saveServer, removeServer, serversReady, serverError,
    busy: syncing || saving, syncing, saving, loading: Boolean(id && !snapshot && api), error: snapshot?.error
  }
}

export type TaskWorkspace = ReturnType<typeof useTaskWorkspace>
