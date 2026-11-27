import { useCallback, useEffect, useRef, useState } from 'react'
import type { CalDavTask, CalDavTaskList, CalDavTaskListChange, TaskServer, TaskServerInput } from '@shared/task-model'

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

  async function toggle(task: CalDavTask) {
    if (!id || !api || pending.current) return
    pending.current = true
    setSaving(true)
    try {
      const result = await api.setCompleted(id, task.id, !task.completed)
      if (result.status === 'saved') {
        setSnapshots((current) => ({
          ...current,
          [id]: {
            lists: current[id].lists.map((list) => ({
              ...list, tasks: list.tasks.map((item) => item.id === task.id ? result.task : item)
            }))
          }
        }))
      }
      return result.status
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
    sources, account, lists, selectedList, selectList, selectServer, sync, changeList, toggle,
    saveServer, removeServer, serversReady, serverError,
    busy: syncing || saving, syncing, saving, loading: Boolean(id && !snapshot && api), error: snapshot?.error
  }
}

export type TaskWorkspace = ReturnType<typeof useTaskWorkspace>
