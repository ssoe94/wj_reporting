import { Card, CardHeader, CardContent } from '../../components/ui/card';
import { useAssemblyReportsSummary } from '../../hooks/useAssemblyReports';
import { useLang } from '../../i18n';
import AssemblyTrendChart from '../../components/AssemblyTrendChart';

export default function AssemblySummaryPage() {
  const { t } = useLang();
  const { data: summary, isLoading } = useAssemblyReportsSummary();

  const stats = [
    {
      title: t('total_prod'),
      value: summary?.total_count || 0,
      unit: t('total_prod_unit'),
      color: 'bg-blue-500',
    },
    {
      title: t('assembly_plan_qty'),
      value: summary?.total_plan_qty || 0,
      unit: '개',
      color: 'bg-gray-500',
    },
    {
      title: t('assembly_actual_qty'),
      value: summary?.total_actual_qty || 0,
      unit: '개',
      color: 'bg-green-500',
    },
    {
      title: t('assembly_defect_qty'),
      value: summary?.total_defect_qty || 0,
      unit: '개',
      color: 'bg-red-500',
    },
  ];

  const performanceStats = [
    {
      title: t('achievement_rate'),
      value: summary?.achievement_rate || 0,
      unit: '%',
      color: (summary?.achievement_rate || 0) >= 100 ? 'text-green-600' : 
             (summary?.achievement_rate || 0) >= 80 ? 'text-yellow-600' : 'text-red-600',
    },
    {
      title: t('defect_rate'),
      value: summary?.defect_rate || 0,
      unit: '%',
      color: (summary?.defect_rate || 0) <= 2 ? 'text-green-600' : 
             (summary?.defect_rate || 0) <= 5 ? 'text-yellow-600' : 'text-red-600',
    },
  ];

  const defectBreakdown = [
    {
      type: t('assembly_injection_defect'),
      value: summary?.total_injection_defect || 0,
      color: 'bg-blue-500',
    },
    {
      type: t('assembly_outsourcing_defect'),
      value: summary?.total_outsourcing_defect || 0,
      color: 'bg-purple-500',
    },
    {
      type: t('assembly_incoming_defect'),
      value: summary?.total_incoming_defect || 0,
      color: 'bg-orange-500',
    },
    {
      type: t('assembly_processing_defect'),
      value: summary?.total_processing_defect || 0,
      color: 'bg-red-500',
    },
  ];

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">{t('assembly_production_summary')}</h1>
      </div>

      {isLoading ? (
        <div className="flex justify-center items-center h-64">
          <div className="text-gray-500">{t('loading')}</div>
        </div>
      ) : (
        <div className="space-y-6">
          {/* 메인 레이아웃: 2x2 기본 통계 + 성과 지표 */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* 2x2 기본 통계 카드 */}
            <div className="lg:col-span-2 grid grid-cols-2 gap-4">
              {stats.map((stat, index) => (
                <Card key={index} className="p-3">
                  <CardHeader className="text-gray-600 pb-1 text-sm">{stat.title}</CardHeader>
                  <CardContent className="pt-0">
                    <p className={`text-lg font-bold ${stat.color.replace('bg-', 'text-')}`}>
                      {stat.value.toLocaleString()}{stat.unit}
                    </p>
                  </CardContent>
                </Card>
              ))}
            </div>

            {/* 성과 지표 (달성률과 불량률) */}
            <div className="space-y-4">
              {/* 달성률 */}
              <Card className="p-4">
                <div className="text-center">
                  <h3 className="text-sm font-medium text-gray-900 mb-1">{performanceStats[0].title}</h3>
                  <div className={`text-2xl font-bold ${performanceStats[0].color}`}>
                    {performanceStats[0].value.toFixed(1)}{performanceStats[0].unit}
                  </div>
                  <div className="mt-2">
                    <div className="w-full bg-gray-200 rounded-full h-2">
                      <div
                        className={`h-2 rounded-full ${
                          performanceStats[0].value >= 100 ? 'bg-green-500' : 
                          performanceStats[0].value >= 80 ? 'bg-yellow-500' : 'bg-red-500'
                        }`}
                        style={{ width: `${Math.min(performanceStats[0].value, 100)}%` }}
                      ></div>
                    </div>
                  </div>
                </div>
              </Card>

              {/* 불량률 (불량 분류 포함) */}
              <Card className="p-4 relative">
                <div className="text-center">
                  <h3 className="text-sm font-medium text-gray-900 mb-1">{performanceStats[1].title}</h3>
                  <div className={`text-2xl font-bold ${performanceStats[1].color}`}>
                    {performanceStats[1].value.toFixed(1)}{performanceStats[1].unit}
                  </div>
                  <div className="mt-2">
                    <div className="w-full bg-gray-200 rounded-full h-2">
                      <div
                        className={`h-2 rounded-full ${
                          performanceStats[1].value <= 2 ? 'bg-green-500' : 
                          performanceStats[1].value <= 5 ? 'bg-yellow-500' : 'bg-red-500'
                        }`}
                        style={{ width: `${Math.min(performanceStats[1].value * 10, 100)}%` }}
                      ></div>
                    </div>
                  </div>
                  
                  {/* 불량 분류 오버레이 */}
                  <div className="mt-3 space-y-1">
                    {defectBreakdown.map((defect, index) => (
                      <div key={index} className="flex justify-between items-center text-xs">
                        <span className="text-gray-600">{defect.type.replace('조립 ', '')}</span>
                        <div className="flex items-center gap-1">
                          <span className="font-medium">{defect.value}개</span>
                          <span className="text-gray-500">
                            ({summary?.total_defect_qty && summary.total_defect_qty > 0 
                              ? `${((defect.value / summary.total_defect_qty) * 100).toFixed(1)}%`
                              : '0%'
                            })
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </Card>
            </div>
          </div>

          {/* 생산 추이 그래프 */}
          <AssemblyTrendChart />
        </div>
      )}
    </div>
  );
}