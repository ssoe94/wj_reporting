import OEEDashboard from '@/components/OEEDashboard';
import DowntimeAnalysis from '@/components/DowntimeAnalysis';
import { PeriodProvider } from '@/contexts/PeriodContext';
import PeriodSelector from '@/components/PeriodSelector';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { useLang } from '@/i18n';

export default function AnalysisPage() {
  const { t } = useLang();

  return (
    <PeriodProvider>
      <div className="mx-auto max-w-7xl px-4 py-10 md:px-8 flex flex-col gap-10">
          <PeriodSelector />
          <div className="space-y-6">
            <h1 className="text-2xl font-bold text-blue-700">{t('nav_analysis')}</h1>

            <Card>
              <CardHeader>
                <h2 className="text-xl font-semibold">{t('oee_title')}</h2>
                <p className="text-sm text-gray-600">
                  {t('oee_desc')}
                </p>
              </CardHeader>
              <CardContent>
                <OEEDashboard />
              </CardContent>
            </Card>

            {/* 다운타임 분석 */}
            <Card>
              <CardHeader>
                <h2 className="text-xl font-semibold">{t('downtime_title')}</h2>
                <p className="text-sm text-gray-600">
                  {t('downtime_desc')}
                </p>
              </CardHeader>
              <CardContent>
                <DowntimeAnalysis />
              </CardContent>
            </Card>

            {/* 향후 확장을 위한 플레이스홀더 */}
            <Card>
              <CardHeader>
                <h3 className="text-lg font-semibold">{t('spc_title')}</h3>
                <p className="text-sm text-gray-600">{t('spc_desc')}</p>
              </CardHeader>
              <CardContent>
                <p className="text-gray-500 text-sm">{t('preparing')}</p>
              </CardContent>
            </Card>
          </div>
        </div>
      </PeriodProvider>
  );
} 