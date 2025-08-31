
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { toast } from 'react-toastify';
import { Button } from '../../components/ui/button';
import { useExportAssemblyReports, useAssemblyReports } from '../../hooks/useAssemblyReports';
import AssemblyProdCalendar from '../../components/AssemblyProdCalendar';
import AssemblyDateRecordsTable from '../../components/AssemblyDateRecordsTable';
import { DownloadCloud } from 'lucide-react';
import { useLang } from '../../i18n';

export default function AssemblyRecordsPage() {
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const exportMutation = useExportAssemblyReports();
  const { data: reportsData } = useAssemblyReports();
  const { t } = useLang();
  const location = useLocation();

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const d = params.get('date');
    if (d) setSelectedDate(d);
  }, [location.search]);

  // 컴포넌트 마운트 시 최근 날짜로 자동 선택
  useEffect(() => {
    const reports = reportsData?.results || [];
    if (reports.length > 0 && !selectedDate) {
      // 날짜순으로 정렬해서 가장 최근 날짜 선택
      const sortedDates = reports
        .map((r: any) => r.date)
        .sort((a: string, b: string) => b.localeCompare(a)); // 내림차순 정렬
      if (sortedDates.length > 0) {
        setSelectedDate(sortedDates[0]);
      }
    }
  }, [reportsData, selectedDate]);

  const handleExport = async () => {
    try {
      await exportMutation.mutateAsync({});
      toast.success('CSV 파일이 다운로드되었습니다.');
    } catch (error) {
      toast.error('내보내기에 실패했습니다.');
    }
  };

  // CSV 업로드 비활성화


  return (
    <div className="p-6">

      <div className="md:flex gap-6">
        {/* 왼쪽: 테이블 영역 */}
        <div className="flex-1 space-y-4 overflow-auto max-h-[65vh]">
          {selectedDate ? (
            <>
              <h3 className="text-lg font-bold">{selectedDate} {t('detailed_record')}</h3>
              <AssemblyDateRecordsTable date={selectedDate} />
            </>
          ) : (
            <div className="flex items-center justify-center h-48">
              <p className="text-gray-400 text-lg">날짜를 선택하면 해당 날짜의 생산 기록을 확인할 수 있습니다</p>
            </div>
          )}
        </div>

        {/* 오른쪽: 캘린더 */}
        <div className="flex-shrink-0 space-y-4 mt-9 md:mt-11">
          <AssemblyProdCalendar selected={selectedDate} onSelect={setSelectedDate} />

          <div className="flex justify-center gap-2">
            <Button size="sm" className="gap-2" onClick={handleExport} disabled={exportMutation.isPending}>
              <DownloadCloud className="h-4 w-4" /> 
              {exportMutation.isPending ? '내보내는 중...' : 'CSV 저장'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
} 