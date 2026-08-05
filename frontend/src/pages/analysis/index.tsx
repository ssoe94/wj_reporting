import { useState } from 'react';
import OEEDashboard from '@/components/OEEDashboard';
import DowntimeAnalysis from '@/components/DowntimeAnalysis';
import AssemblyDashboard from '@/components/AssemblyDashboard';
import { PeriodProvider } from '@/contexts/PeriodContext';
import PeriodSelector from '@/components/PeriodSelector';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { useLang } from '@/i18n';
import { ChartNoAxesCombined } from 'lucide-react';
import { PageContainer, PageHeader } from '@/components/layout/PageLayout';

export default function AnalysisPage() {
  const { t } = useLang();
  const [activeTab, setActiveTab] = useState<'injection' | 'assembly'>('injection');

  return (
    <PeriodProvider>
      <PageContainer>
        <PageHeader
          actions={(
            <div
              className="ui-segmented-control"
              role="tablist"
              aria-label={t('analysis_tablist_label')}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                event.preventDefault();
                const nextTab = activeTab === 'injection' ? 'assembly' : 'injection';
                setActiveTab(nextTab);
                requestAnimationFrame(() => document.getElementById(`analysis-tab-${nextTab}`)?.focus());
              }}
            >
              <button
                id="analysis-tab-injection"
                aria-controls="analysis-panel-injection"
                aria-selected={activeTab === 'injection'}
                className={activeTab === 'injection' ? 'is-active' : ''}
                onClick={() => setActiveTab('injection')}
                role="tab"
                tabIndex={activeTab === 'injection' ? 0 : -1}
                type="button"
              >
                {t('analysis_tab_injection')}
              </button>
              <button
                id="analysis-tab-assembly"
                aria-controls="analysis-panel-assembly"
                aria-selected={activeTab === 'assembly'}
                className={activeTab === 'assembly' ? 'is-active' : ''}
                onClick={() => setActiveTab('assembly')}
                role="tab"
                tabIndex={activeTab === 'assembly' ? 0 : -1}
                type="button"
              >
                {t('analysis_tab_assembly')}
              </button>
            </div>
          )}
          eyebrow="ANALYTICS"
          icon={ChartNoAxesCombined}
          title={t('nav_analysis')}
        />
        <PeriodSelector />
        {activeTab === 'injection' && (
            <section
              id="analysis-panel-injection"
              aria-labelledby="analysis-tab-injection"
              className="app-page__sections"
              role="tabpanel"
              tabIndex={0}
            >
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
            </section>
        )}

        {activeTab === 'assembly' && (
            <section
              id="analysis-panel-assembly"
              aria-labelledby="analysis-tab-assembly"
              className="app-page__sections"
              role="tabpanel"
              tabIndex={0}
            >
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
            </section>
        )}
      </PageContainer>
    </PeriodProvider>
  );
}
