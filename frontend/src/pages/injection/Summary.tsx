import { useLang } from '@/i18n';

export default function InjectionSummaryPage() {
  const { t } = useLang();
  return (
    <div className="p-4">
      <h1 className="text-xl font-semibold mb-2">{t('nav_injection_summary')}</h1>
      <p>Injection summary page under construction.</p>
    </div>
  );
}