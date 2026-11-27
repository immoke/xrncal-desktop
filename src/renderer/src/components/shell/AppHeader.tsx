import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { DateTime } from 'luxon'
import { CalendarDays, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, ListChecks, Menu, Plus, Search, Settings } from 'lucide-react'
import type { CalendarViewType } from '@shared/visible-range'
import type { Calendar, CalendarAccount } from '@shared/event-model'
import { SyncButtons } from './SyncButtons'
import { MonthYearPicker } from '../MonthYearPicker'
import ViewSwitcher from './ViewSwitcher'
import { ContextMenu } from '../ui'

interface AppHeaderProps {
  showTasks: boolean
  onSelectWorkspace: (tasks: boolean) => void
  sidebarCollapsed: boolean
  onOpenMenu: () => void
  title: string
  currentView: CalendarViewType
  anchorDate: DateTime
  onSelectDate: (date: DateTime) => void
  showSidebarToggle?: boolean
  onToggleSidebar: () => void
  onPrev: () => void
  onNext: () => void
  calendars: Calendar[]
  accounts: CalendarAccount[]
  syncSources?: Pick<CalendarAccount, 'id' | 'name'>[]
  syncing: boolean
  onSync: (sourceId?: string) => void
  onNewEvent: () => void
  onChangeView: (view: CalendarViewType) => void
  onSearch: () => void
  conflictCount?: number
}

/**
 * Period navigation on the left, calendar actions on the right. T goes to
 * today, as does Week view's week number.
 */
export const AppHeader: React.FC<AppHeaderProps> = ({
  showTasks,
  onSelectWorkspace,
  sidebarCollapsed,
  onOpenMenu,
  title,
  currentView,
  anchorDate,
  onSelectDate,
  showSidebarToggle = true,
  onToggleSidebar,
  onPrev,
  onNext,
  calendars,
  accounts,
  syncSources,
  syncing,
  onSync,
  onNewEvent,
  onChangeView,
  onSearch,
  conflictCount
}) => {
  const { t } = useTranslation()
  const [workspaceMenu, setWorkspaceMenu] = useState<{ x: number; y: number } | null>(null)
  const isYearView = currentView === 'year'
  const sidebarAction = t(sidebarCollapsed ? 'tasks.expandSidebar' : 'tasks.collapseSidebar')

  return (
    <header className="relative z-20 flex h-12 shrink-0 items-center justify-between gap-2 border-b border-hairline bg-surface px-3 select-none">
      <div className="flex min-w-0 items-center gap-2">
        <button type="button" className="gc-btn shrink-0" title={t('tasks.switchWorkspace')}
          aria-haspopup="menu" aria-expanded={Boolean(workspaceMenu)} onClick={(event) => {
            const position = event.currentTarget.getBoundingClientRect()
            setWorkspaceMenu(workspaceMenu ? null : { x: position.left, y: position.bottom + 3 })
          }}>
          <Menu className="h-4 w-4" />
          <span>{t(showTasks ? 'tasks.title' : 'tasks.calendar')}</span>
        </button>
        <ContextMenu at={workspaceMenu} label={t('tasks.switchWorkspace')} onClose={() => setWorkspaceMenu(null)} entries={[
          { label: t('tasks.calendar'), icon: <CalendarDays className="h-4 w-4" />, onSelect: () => onSelectWorkspace(false) },
          { label: t('tasks.title'), icon: <ListChecks className="h-4 w-4" />, onSelect: () => onSelectWorkspace(true) }
        ]} />
        {showSidebarToggle && (
          <button
            type="button"
            className="gc-icon-btn"
            onClick={onToggleSidebar}
            title={`${sidebarAction} (Ctrl+B)`}
            aria-label={sidebarAction}
            aria-expanded={!sidebarCollapsed}
          >
            {sidebarCollapsed ? <ChevronsRight className="h-5 w-5" /> : <ChevronsLeft className="h-5 w-5" />}
          </button>
        )}
        {!showTasks && <div className="flex shrink-0 items-center">
          <button type="button" className="gc-icon-btn" onClick={onPrev} title={t('nav.prev')} aria-label={t('nav.prev')}>
            <ChevronLeft className="h-5 w-5" />
          </button>
          <button type="button" className="gc-icon-btn" onClick={onNext} title={t('nav.next')} aria-label={t('nav.next')}>
            <ChevronRight className="h-5 w-5" />
          </button>
        </div>}
        {!showTasks && title && !isYearView && (
          <h1 className="truncate py-0.5 text-[28px] font-normal leading-snug tracking-tight text-primary">
            {currentView === 'month' ? <MonthYearPicker date={anchorDate} onChange={onSelectDate} /> : title}
          </h1>
        )}
      </div>

      {!showTasks && title && isYearView && (
        <h1 className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-[28px] font-normal leading-snug tracking-tight text-primary">
          {title}
        </h1>
      )}

      <div className="flex shrink-0 items-center gap-1">
        <SyncButtons calendars={calendars} accounts={accounts} syncing={syncing} onSync={onSync} sources={syncSources}
          sourceLabel={showTasks ? t('tasks.syncServer') : undefined} />
        {!showTasks && <>
        <button
          type="button"
          className="gc-btn-primary mr-1"
          onClick={onNewEvent}
          title={`${t('actions.newEvent')} (N)`}
        >
          <Plus className="h-4 w-4" />
          <span>{t('actions.newEvent')}</span>
        </button>
        <button
          type="button"
          className="gc-icon-btn"
          onClick={onSearch}
          title={`${t('actions.search')} (Ctrl+K)`}
          aria-label={t('actions.search')}
        >
          <Search className="h-4 w-4" />
        </button>

        <ViewSwitcher currentView={currentView} onChange={onChangeView} />
        </>}
        <button
          type="button"
          onClick={onOpenMenu}
          className="gc-icon-btn relative"
          title={showTasks ? t('tasks.servers') : `${t('settings.title')} (,)`}
          aria-label={t(showTasks ? 'tasks.servers' : 'settings.title')}
        >
          <Settings className="h-4 w-4" />
          {conflictCount ? (
            <span className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-today" />
          ) : null}
        </button>
      </div>
    </header>
  )
}

export default AppHeader
