import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Loader2 } from 'lucide-react'
import type { Calendar } from '@shared/event-model'
import { CHINA_CALENDAR_URL, type HolidayCalendarOption } from '@shared/holiday-calendars'

const OPTIONS = [
  { type: 'vietnam', icon: '🇻🇳' },
  { type: 'china', icon: '🇨🇳' },
  { type: 'international', icon: '🌐' }
] as const

interface HolidayCalendarToggleProps {
  calendars: Calendar[]
  onCalendarsChanged: () => void | Promise<void>
}

export default function HolidayCalendarToggle({ calendars, onCalendarsChanged }: HolidayCalendarToggleProps) {
  const { t } = useTranslation()
  const [loadingType, setLoadingType] = useState<HolidayCalendarOption | null>(null)
  const [failed, setFailed] = useState(false)

  async function handleToggle(type: HolidayCalendarOption, subscribed: boolean) {
    if (!window.xrncal?.holidays || loadingType) return
    setLoadingType(type)
    setFailed(false)
    try {
      if (subscribed) await window.xrncal.holidays.unsubscribe(type)
      else await window.xrncal.holidays.subscribe(type)
      await onCalendarsChanged()
    } catch {
      setFailed(true)
    } finally {
      setLoadingType(null)
    }
  }

  return (
    <div className="space-y-1 select-none">
      {OPTIONS.map(({ type, icon }) => {
        const subscribed = calendars.some((calendar) => type === 'china'
          ? calendar.subscriptionUrl === CHINA_CALENDAR_URL
          : calendar.holidayType === type)
        return (
          <button key={type} type="button" aria-label={t(`holidays.${type}`)} aria-pressed={subscribed}
            disabled={Boolean(loadingType)} onClick={() => void handleToggle(type, subscribed)}
            className={`flex w-full items-center justify-between px-2 py-1.5 rounded-[4px] border text-xs text-left transition-colors ${
              subscribed ? 'bg-accent/10 border-accent/30 text-primary'
                : 'bg-surface border-hairline text-muted hover:bg-hover hover:text-primary'
            }`}>
            <span className="flex items-center gap-2 min-w-0">
              <span className="text-sm shrink-0" aria-hidden>{icon}</span>
              <span className="font-medium text-xs truncate">{t(`holidays.${type}`)}</span>
            </span>
            <span className="shrink-0 flex items-center">
              {loadingType === type ? <Loader2 className="h-3 w-3 text-accent animate-spin" /> : subscribed ? (
                <span className="px-1.5 py-0.5 rounded-[3px] bg-accent/20 text-accent text-[10px] font-medium flex items-center gap-0.5">
                  <Check className="h-2.5 w-2.5" /> {t('common.on')}
                </span>
              ) : <span className="text-[10px] text-muted font-medium">{t('holidays.enable')}</span>}
            </span>
          </button>
        )
      })}
      {failed && <p role="alert" className="text-xs text-today">{t('holidays.changeFailed')}</p>}
    </div>
  )
}
