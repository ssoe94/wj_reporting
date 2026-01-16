import { BarChart3, AlertCircle } from 'lucide-react';
import { useLang } from '../../i18n';

export default function ProductionStatsPage() {
  const { t } = useLang();

  return (
    <div className="px-4 py-6 md:px-8 md:py-10">
      <div className="max-w-[1400px] mx-auto">
        <div className="bg-white rounded-2xl shadow p-8 flex flex-col items-center text-center space-y-4 border border-dashed border-blue-200">
          <BarChart3 className="w-14 h-14 text-blue-500" />
          <div>
            <p className="text-sm uppercase tracking-wide text-gray-400 mb-1">{t('plan_stats_tag')}</p>
            <h1 className="text-2xl font-semibold text-gray-900 mb-1">{t('plan_stats_title')}</h1>
            <p className="text-gray-600 max-w-2xl">{t('plan_stats_description')}</p>
          </div>
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <AlertCircle className="w-4 h-4" />
            <span>{t('plan_stats_placeholder')}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
