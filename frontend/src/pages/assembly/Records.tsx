
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { toast } from 'react-toastify';
import { Button } from '../../components/ui/button';
import { useExportAssemblyReports, useAssemblyReportDates } from '../../hooks/useAssemblyReports';
import api from '../../lib/api';
import AssemblyProdCalendar from '../../components/AssemblyProdCalendar';
import AssemblyDateRecordsTable from '../../components/AssemblyDateRecordsTable';
import { DownloadCloud } from 'lucide-react';
import { useLang } from '../../i18n';

export default function AssemblyRecordsPage() {
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const exportMutation = useExportAssemblyReports();
  const { data: reportDates = [], isLoading: isDatesLoading } = useAssemblyReportDates();
  const { t } = useLang();
  const location = useLocation();

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const d = params.get('date');
    if (d) {
      setSelectedDate(d);
    }
  }, [location.search]);

  useEffect(() => {
    if (!selectedDate && reportDates.length > 0) {
      setSelectedDate(reportDates[0]);
    }
  }, [reportDates, selectedDate]);
  
  useEffect(() => {
    if (selectedDate && reportDates.length > 0 && !reportDates.includes(selectedDate)) {
      setSelectedDate(reportDates[0]);
    }
  }, [reportDates, selectedDate]);

  const handleExport = async () => {
    try {
      await exportMutation.mutateAsync({});
      toast.success('CSV 파일이 다운로드되었습니다.');
    } catch (error) {
      toast.error('내보내기에 실패했습니다.');
    }
  };

  // CSV 업로드 기능
  const handleCsvUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    try {
      const { data } = await api.post('/assembly/reports/bulk-import/', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });

      toast.success(`생성 ${data.created}건 / 중복 ${data.skipped}건 / 오류 ${data.errors}건`);
      // 데이터 새로고침을 위해 쿼리 무효화
      window.location.reload();
    } catch (err: any) {
      console.error('CSV upload error:', err);
      if (err.response?.data?.detail) {
        toast.error(`CSV 업로드 실패: ${err.response.data.detail}`);
      } else if (err.response?.status) {
        toast.error(`CSV 업로드 실패: HTTP ${err.response.status}`);
      } else {
        toast.error('CSV 업로드 실패: 네트워크 오류');
      }
    } finally {
      // 파일 입력 초기화
      event.target.value = '';
    }
  };


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
              <p className="text-gray-400 text-lg">
                {isDatesLoading ? '날짜 목록을 불러오는 중입니다…' : '날짜를 선택하면 해당 날짜의 생산 기록을 확인할 수 있습니다'}
              </p>
            </div>
          )}
        </div>

        {/* 오른쪽: 캘린더 */}
        <div className="flex-shrink-0 space-y-4 mt-9 md:mt-11">
          <AssemblyProdCalendar selected={selectedDate} onSelect={setSelectedDate} availableDates={reportDates} />

          <div className="flex justify-center gap-2">
            <input
              id="csvFile"
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={handleCsvUpload}
            />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => document.getElementById('csvFile')?.click()}
            >
              CSV 업로드
            </Button>
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
