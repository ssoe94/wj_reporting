import { useState } from 'react';
import OEEDashboard from '@/components/OEEDashboard';
import DowntimeAnalysis from '@/components/DowntimeAnalysis';
import AssemblyDashboard from '@/components/AssemblyDashboard';
import { PeriodProvider } from '@/contexts/PeriodContext';
import PeriodSelector from '@/components/PeriodSelector';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { useLang } from '@/i18n';

export default function AnalysisPage() {
  const { t } = useLang();
  const [activeTab, setActiveTab] = useState<'injection' | 'assembly'>('injection');

  return (
    <PeriodProvider>
      <div className="mx-auto max-w-7xl px-4 py-10 md:px-8 flex flex-col gap-10">
        <PeriodSelector />
        <div className="space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold text-blue-700">{t('nav_analysis')}</h1>
              <div
                className="inline-flex items-center rounded-full bg-gray-50 px-1 py-1 border border-gray-200 shadow-sm"
                role="tablist"
                aria-label={t('analysis_tablist_label')}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === 'injection'}
                  className={`px-4 py-1.5 text-sm font-medium rounded-full transition-all ${
                    activeTab === 'injection'
                      ? 'bg-white text-blue-600 shadow-md ring-1 ring-blue-200'
                      : 'text-gray-600 hover:text-blue-600'
                  }`}
                  onClick={() => setActiveTab('injection')}
                >
                  {t('analysis_tab_injection')}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === 'assembly'}
                  className={`px-4 py-1.5 text-sm font-medium rounded-full transition-all ${
                    activeTab === 'assembly'
                      ? 'bg-white text-blue-600 shadow-md ring-1 ring-blue-200'
                      : 'text-gray-600 hover:text-blue-600'
                  }`}
                  onClick={() => setActiveTab('assembly')}
                >
                  {t('analysis_tab_assembly')}
                </button>
              </div>
            </div>
          </div>

          {activeTab === 'injection' && (
            <>
              <Card>
                <CardHeader>
                  <h2 className="text-xl font-semibold">{t('oee_title')}</h2>
                  <p className="text-sm text-gray-600">{t('oee_desc')}</p>
                </CardHeader>
                <CardContent>
                  <OEEDashboard />
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <h2 className="text-xl font-semibold">{t('downtime_title')}</h2>
                  <p className="text-sm text-gray-600">{t('downtime_desc')}</p>
                </CardHeader>
                <CardContent>
                  <DowntimeAnalysis />
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <h3 className="text-lg font-semibold">{t('spc_title')}</h3>
                  <p className="text-sm text-gray-600">{t('spc_desc')}</p>
                </CardHeader>
                <CardContent>
                  <p className="text-gray-500 text-sm">{t('preparing')}</p>
                </CardContent>
              </Card>
            </>
          )}

          {activeTab === 'assembly' && (
            <>
              <Card>
                <CardHeader>
                  <h2 className="text-xl font-semibold">{t('analysis_assembly_title')}</h2>
                  <p className="text-sm text-gray-600">{t('analysis_assembly_desc')}</p>
                </CardHeader>
                <CardContent>
                  <AssemblyDashboard />
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <h3 className="text-lg font-semibold">{t('spc_title')}</h3>
                  <p className="text-sm text-gray-600">{t('spc_desc')}</p>
                </CardHeader>
                <CardContent>
                  <p className="text-gray-500 text-sm">{t('preparing')}</p>
                </CardContent>
              </Card>
            </>
          )}
        </div>
      </div>
    </PeriodProvider>
  );
}
