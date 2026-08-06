import { type ChangeEvent, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { DownloadCloud, FilePlus2, History } from 'lucide-react';
import { toast } from 'react-toastify';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import DateRecordsTable from '@/components/DateRecordsTable';
import ProdCalendar from '@/components/ProdCalendar';
import ProdTrendChart from '@/components/ProdTrendChart';
import RecordForm from '@/components/RecordForm';
import api from '@/lib/api';
import { useLang } from '@/i18n';
import { useReportDates, useReportSummary } from '@/hooks/useReports';

export default function InjectionReportsPanel() {
  const { t } = useLang();
  const queryClient = useQueryClient();
  const { data: summary } = useReportSummary();
  const { data: reportDates = [] } = useReportDates();
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  useEffect(() => {
    if (reportDates.length > 0 && !selectedDate) {
      setSelectedDate(reportDates[0]);
    }
  }, [reportDates, selectedDate]);

  const refreshReportQueries = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['reports'] }),
      queryClient.invalidateQueries({ queryKey: ['reports-summary'] }),
      queryClient.invalidateQueries({ queryKey: ['report-dates'] }),
    ]);
  };

  const handleRecordSaved = (savedDate: string) => {
    setSelectedDate(savedDate);
    void refreshReportQueries();
    window.setTimeout(() => {
      document.getElementById('records')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);
  };

  const downloadCsv = async () => {
    try {
      const response = await api.get('/injection/reports/export/', { responseType: 'blob' });
      const url = URL.createObjectURL(response.data);
      const link = document.createElement('a');
      link.href = url;

      const contentDisposition = response.headers['content-disposition'];
      const filenameMatch = contentDisposition?.match(/filename="?([^"]+)"?/);
      link.download = filenameMatch?.[1] || 'injection_reports.csv';

      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error(error);
      toast.error('CSV 다운로드 실패');
    }
  };

  const handleCsvUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    try {
      const { data } = await api.post('/injection/reports/bulk-import/', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      toast.success(`생성 ${data.created}건 / 중복 ${data.skipped}건 / 오류 ${data.errors}건`);
      await refreshReportQueries();
    } catch (error: any) {
      console.error('CSV upload error:', error);
      if (error.response?.data?.detail) {
        toast.error(`CSV 업로드 실패: ${error.response.data.detail}`);
      } else if (error.response?.status) {
        toast.error(`CSV 업로드 실패: HTTP ${error.response.status}`);
      } else {
        toast.error('CSV 업로드 실패: 네트워크 오류');
      }
    } finally {
      event.target.value = '';
    }
  };

  return (
    <div className="space-y-8">
      <section id="records" className="space-y-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-sky-100 bg-sky-50 px-3 py-1 text-xs font-bold uppercase tracking-[0.18em] text-sky-700">
              <History className="h-3.5 w-3.5" />
              Injection records
            </div>
            <h2 className="mt-3 text-2xl font-black tracking-tight text-slate-900">{t('nav_injection_records')}</h2>
            <p className="mt-1 text-sm text-slate-500">
              기록 조회, CSV 입출력, 신규 등록을 사출 대시보드 안에서 함께 관리합니다.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <input
              id="injectionReportsCsvFile"
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={handleCsvUpload}
            />
            <Button size="sm" variant="ghost" onClick={() => document.getElementById('injectionReportsCsvFile')?.click()}>
              {t('csv_upload')}
            </Button>
            <Button size="sm" className="gap-2" onClick={downloadCsv}>
              <DownloadCloud className="h-4 w-4" />
              {t('csv_save')}
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Card className="border-blue-100 bg-white/80">
            <CardHeader className="pb-2 text-sm text-slate-500">{t('total_prod')}</CardHeader>
            <CardContent>
              <p className="text-3xl font-black text-blue-700">
                {summary ? `${summary.total_count}${t('total_prod_unit')}` : '...'}
              </p>
            </CardContent>
          </Card>
          <Card className="border-emerald-100 bg-white/80">
            <CardHeader className="pb-2 text-sm text-slate-500">{t('avg_ach')}</CardHeader>
            <CardContent>
              <p className="text-3xl font-black text-emerald-600">
                {summary ? `${summary.achievement_rate}%` : '...'}
              </p>
            </CardContent>
          </Card>
          <Card className="border-rose-100 bg-white/80">
            <CardHeader className="pb-2 text-sm text-slate-500">{t('avg_def')}</CardHeader>
            <CardContent>
              <p className="text-3xl font-black text-rose-500">
                {summary ? `${summary.defect_rate}%` : '...'}
              </p>
            </CardContent>
          </Card>
        </div>

        <Card className="border-slate-200 bg-white/85 shadow-sm">
          <CardContent className="pt-6">
            <ProdTrendChart />
          </CardContent>
        </Card>

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
          <Card className="min-h-[420px] border-slate-200 bg-white/85 shadow-sm">
            <CardHeader className="pb-3">
              <h3 className="text-lg font-bold text-slate-900">
                {selectedDate ? `${selectedDate} ${t('detailed_record')}` : t('detailed_record')}
              </h3>
            </CardHeader>
            <CardContent>
              {selectedDate ? (
                <div className="max-h-[62vh] overflow-auto">
                  <DateRecordsTable date={selectedDate} />
                </div>
              ) : (
                <div className="flex h-48 items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-slate-50">
                  <p className="text-slate-400">{t('click_date_guide')}</p>
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="border-slate-200 bg-white/85 shadow-sm">
            <CardHeader className="pb-3">
              <h3 className="text-base font-bold text-slate-900">기록 날짜 선택</h3>
            </CardHeader>
            <CardContent>
              <ProdCalendar selected={selectedDate} onSelect={setSelectedDate} availableDates={reportDates} />
            </CardContent>
          </Card>
        </div>
      </section>

      <section id="new">
        <Card className="border-blue-100 bg-white/90 shadow-sm">
          <CardHeader>
            <div className="flex items-center gap-2">
              <FilePlus2 className="h-5 w-5 text-blue-600" />
              <h2 className="text-xl font-black text-slate-900">{t('new_rec_title')}</h2>
            </div>
          </CardHeader>
          <CardContent>
            <RecordForm onSaved={handleRecordSaved} />
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
