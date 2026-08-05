import { usePeriod } from '../contexts/PeriodContext';
import { useLang } from '../i18n';

export default function PeriodSelector() {
  const { startDate, endDate, excludeWeekends, setStartDate, setEndDate, setExcludeWeekends, reset } = usePeriod();
  const { t } = useLang();

  return (
    <section className="period-selector" aria-label={`${t('start_date')} / ${t('end_date')}`}>
      <div className="period-selector__fields">
        <label className="period-selector__field" htmlFor="startDate">
          <span>{t('start_date')}</span>
          <input
            id="startDate"
            type="date"
            value={startDate}
            onChange={e => setStartDate(e.target.value)}
          />
        </label>
        <label className="period-selector__field" htmlFor="endDate">
          <span>{t('end_date')}</span>
          <input
            id="endDate"
            type="date"
            value={endDate}
            onChange={e => setEndDate(e.target.value)}
          />
        </label>
        <label className="period-selector__check" htmlFor="excludeWeekends">
          <input
            type="checkbox"
            id="excludeWeekends"
            checked={excludeWeekends}
            onChange={e => setExcludeWeekends(e.target.checked)}
          />
          <span>{t('exclude_weekends')}</span>
        </label>
        <button
          type="button"
          onClick={reset}
          className="period-selector__reset"
        >
          {t('reset_to_default')}
        </button>
      </div>
    </section>
  );
}
