
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
      toast.success(t('csv_download_success'));
    } catch (error) {
      toast.error(t('csv_export_fail'));
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

      toast.success(t('csv_upload_success', { created: data.created, skipped: data.skipped, errors: data.errors }));
      // 데이터 새로고침을 위해 쿼리 무효화
      window.location.reload();
    } catch (err: any) {
      console.error('CSV upload error:', err);
      if (err.response?.data?.detail) {
        toast.error(`${t('csv_upload_fail')}: ${err.response.data.detail}`);
      } else if (err.response?.status) {
        toast.error(`${t('csv_upload_fail')}: HTTP ${err.response.status}`);
      } else {
        toast.error(`${t('csv_upload_fail')}: ${t('network_error')}`);
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
                {isDatesLoading ? t('loading_dates') : t('select_date_guide')}
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
              {t('csv_upload')}
            </Button>
            <Button size="sm" className="gap-2" onClick={handleExport} disabled={exportMutation.isPending}>
              <DownloadCloud className="h-4 w-4" />
              {exportMutation.isPending ? t('exporting') : t('csv_save')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
} 
