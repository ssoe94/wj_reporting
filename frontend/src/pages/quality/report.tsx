import { ClipboardList } from 'lucide-react';
import { useLang } from '../../i18n';

export default function QualityReport() {
  const { t } = useLang();
  return (
    <div className="rounded-lg border border-gray-200 bg-white shadow-sm">
      <div className="flex items-center gap-2 border-b border-gray-200 px-4 py-3">
        <ClipboardList className="w-5 h-5 text-rose-500" />
        <h2 className="text-base font-semibold text-gray-800">{t('nav_quality_report')}</h2>
      </div>
      <div className="px-4 py-6 text-gray-500">
        {t('preparing')}
      </div>
    </div>
  );
}



