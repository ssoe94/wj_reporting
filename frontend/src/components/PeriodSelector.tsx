import { usePeriod } from '../contexts/PeriodContext';
import { useLang } from '../i18n';

export default function PeriodSelector() {
  const { startDate, endDate, excludeWeekends, setStartDate, setEndDate, setExcludeWeekends, reset } = usePeriod();
  const { t } = useLang();

  return (
    <div className="flex flex-col md:flex-row md:items-center gap-4 p-4 bg-white rounded-xl shadow mb-6">
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <label htmlFor="startDate" className="text-sm font-medium">{t('start_date')}</label>
          <input
            id="startDate"
            type="date"
            value={startDate}
            onChange={e => setStartDate(e.target.value)}
            className="border rounded px-2 py-1"
          />
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="endDate" className="text-sm font-medium">{t('end_date')}</label>
          <input
            id="endDate"
            type="date"
            value={endDate}
            onChange={e => setEndDate(e.target.value)}
            className="border rounded px-2 py-1"
          />
        </div>
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="excludeWeekends"
            checked={excludeWeekends}
            onChange={e => setExcludeWeekends(e.target.checked)}
            className="rounded"
          />
          <label htmlFor="excludeWeekends" className="text-sm">{t('exclude_weekends')}</label>
        </div>
        <button
          type="button"
          onClick={reset}
          className="px-3 py-1 bg-blue-100 text-blue-700 rounded border border-blue-300 text-sm hover:bg-blue-200"
        >
          {t('reset_to_default')}
        </button>
      </div>
    </div>
  );
} 