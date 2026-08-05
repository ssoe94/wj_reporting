
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { toast } from 'react-toastify';
import { Button } from '../../components/ui/button';
import { useExportAssemblyReports, useAssemblyReportDates } from '../../hooks/useAssemblyReports';
import api from '../../lib/api';
import AssemblyProdCalendar from '../../components/AssemblyProdCalendar';
import AssemblyDateRecordsTable from '../../components/AssemblyDateRecordsTable';
import { CalendarSearch, DownloadCloud, FileUp, ListChecks } from 'lucide-react';
import { useLang } from '../../i18n';

export default function AssemblyRecordsPage() {
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const exportMutation = useExportAssemblyReports();
  const { data: reportDates = [], isLoading: isDatesLoading } = useAssemblyReportDates();
  const { t, lang } = useLang();
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
    } catch (_error) {
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
    <div className="assembly-records-section">
      <div className="assembly-records-section__heading">
        <div className="assembly-records-section__intro">
          <span className="assembly-records-section__icon" aria-hidden="true">
            <ListChecks />
          </span>
          <div>
            <h2>{lang === 'zh' ? '生产记录查询' : '생산 기록 조회'}</h2>
            <p>
              {lang === 'zh'
                ? '按有记录的日期查看详细生产数据。'
                : '기록이 있는 날짜를 선택해 상세 생산 내역을 확인합니다.'}
            </p>
          </div>
        </div>

        <div className="assembly-records-actions">
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
            <FileUp className="h-4 w-4" />
            {t('csv_upload')}
          </Button>
          <Button size="sm" className="gap-2" onClick={handleExport} disabled={exportMutation.isPending}>
            <DownloadCloud className="h-4 w-4" />
            {exportMutation.isPending ? t('exporting') : t('csv_save')}
          </Button>
        </div>
      </div>

      <div className="assembly-records-layout">
        <section className="assembly-records-panel" aria-live="polite">
          <div className="assembly-records-panel__header">
            <div>
              <span>{lang === 'zh' ? '选择日期' : '선택 기준일'}</span>
              <h3>{selectedDate || '-'}</h3>
            </div>
            {selectedDate ? <strong>{t('detailed_record')}</strong> : null}
          </div>
          <div className="assembly-records-panel__body">
            {selectedDate ? (
              <AssemblyDateRecordsTable date={selectedDate} />
            ) : (
              <div className="assembly-records-empty">
                <CalendarSearch aria-hidden="true" />
                <strong>{isDatesLoading ? t('loading_dates') : t('select_date_guide')}</strong>
                <p>
                  {lang === 'zh'
                    ? '选择右侧日历中标记的日期。'
                    : '오른쪽 달력에서 표시된 날짜를 선택하세요.'}
                </p>
              </div>
            )}
          </div>
        </section>

        <aside className="assembly-records-sidebar">
          <AssemblyProdCalendar selected={selectedDate} onSelect={setSelectedDate} availableDates={reportDates} />
        </aside>
      </div>
    </div>
  );
} 
