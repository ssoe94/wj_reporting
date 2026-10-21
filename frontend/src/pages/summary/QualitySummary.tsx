import { BarChart3 } from 'lucide-react';
import { useLang } from '../../i18n';

export default function QualityStats() {
  const { t } = useLang();
  return (
    <div className="rounded-lg border border-[var(--wj-border)] bg-[var(--wj-surface-solid)] shadow-sm">
      <div className="flex items-center gap-2 border-b border-[var(--wj-border)] px-4 py-3">
        <BarChart3 className="w-5 h-5 text-[var(--wj-accent-strong)]" />
        <h2 className="text-base font-semibold text-[var(--wj-text)]">{t('nav_quality_stats')}</h2>
      </div>
      <div className="px-4 py-6 text-[var(--wj-muted)]">
        {t('preparing')}
      </div>
    </div>
  );
}