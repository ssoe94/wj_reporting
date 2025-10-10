import { useState, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { Card, CardContent, CardHeader } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { useLang } from '../../i18n';
import { useReportSummary, useReportDates } from '../../hooks/useReports';
import ProdTrendChart from '../../components/ProdTrendChart';
import ProdCalendar from '../../components/ProdCalendar';
import DateRecordsTable from '../../components/DateRecordsTable';
import { DownloadCloud } from 'lucide-react';
// useQueryClient no longer needed
import { toast } from 'react-toastify';
import api from '../../lib/api';
import RecordForm from '../../components/RecordForm';

// 로컬 날짜 문자열 (YYYY-MM-DD)
export default function SummaryPage() {
  const { t } = useLang();
  const { data: summary } = useReportSummary();
  const { data: reportDates = [] } = useReportDates();
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const location = useLocation();

  // 컴포넌트 마운트 시 최근 날짜로 자동 선택 또는 URL 파라미터 날짜 선택
  useEffect(() => {
    // URL에서 date 파라미터 확인
    const searchParams = new URLSearchParams(location.search);
    const dateParam = searchParams.get('date');

    if (dateParam && reportDates.includes(dateParam)) {
      // URL에 날짜 파라미터가 있고 해당 날짜의 데이터가 존재하면 선택
      setSelectedDate(dateParam);
    } else if (reportDates.length > 0 && !selectedDate) {
      // 그렇지 않으면 최근 날짜로 자동 선택
      setSelectedDate(reportDates[0]);
    }
  }, [reportDates, selectedDate, location.search]);
  // RecordForm 내부 상태로 대체했으므로 관련 코드 삭제

  // 사출기 목록, 포맷 함수 등은 RecordForm 내부로 이동했으므로 삭제합니다.

  const downloadCsv = async () => {
    try {
      const response = await api.get("/reports/export/", { responseType: "blob" });
      const url = URL.createObjectURL(response.data);
      const a = document.createElement("a");
      a.href = url;

      const contentDisposition = response.headers['content-disposition'];
      let filename = 'injection_reports.csv'; // fallback
      if (contentDisposition) {
        const filenameMatch = contentDisposition.match(/filename="?([^"]+)"?/);
        if (filenameMatch && filenameMatch.length > 1) {
          filename = filenameMatch[1];
        }
      }
      a.download = filename;

      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
      toast.error("CSV 다운로드 실패");
    }
  };

  // compute derived values
  // RecordForm 내부 상태로 대체했으므로 관련 코드 삭제

  // Scroll to section on hash change (e.g., #records, #new)
  useEffect(() => {
    if (location.hash) {
      const id = location.hash.replace('#', '');
      const el = document.getElementById(id);
      if (el) {
        setTimeout(() => {
          el.scrollIntoView({ behavior: 'smooth' });
        }, 50);
      } else if (id === 'top') {
        setTimeout(() => window.scrollTo({ top: 0, behavior: 'smooth' }), 50);
      }
    }
  }, [location.hash]);

  return (
    <div className="mx-auto max-w-7xl px-4 py-10 md:px-8 flex flex-col gap-10">
      {/* Summary Section */}
      <section id="summary" className="space-y-6">
        <h2 className="sr-only">현황 요약</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
          <Card className="flex flex-col items-center">
            <CardHeader className="text-gray-500">{t('total_prod')}</CardHeader>
            <CardContent>
              <p className="text-3xl font-bold text-blue-700">
                {summary ? `${summary.total_count}${t('total_prod_unit')}` : '...'}
              </p>
            </CardContent>
          </Card>
          <Card className="flex flex-col items-center">
            <CardHeader className="text-gray-500">{t('avg_ach')}</CardHeader>
            <CardContent>
              <p className="text-3xl font-bold text-green-600">
                {summary ? `${summary.achievement_rate}%` : '...'}
              </p>
            </CardContent>
          </Card>
          <Card className="flex flex-col items-center">
            <CardHeader className="text-gray-500">{t('avg_def')}</CardHeader>
            <CardContent>
              <p className="text-3xl font-bold text-red-500">
                {summary ? `${summary.defect_rate}%` : '...'}
              </p>
            </CardContent>
          </Card>
        </div>
        {/* Plan vs Actual Trend */}
        <ProdTrendChart />
      </section>

      {/* Records Section */}
      <section id="records" className="w-full space-y-4">
        <div className="md:flex gap-6">
          {/* 왼쪽: 테이블 영역 */}
          <div className="flex-1 space-y-4 overflow-auto max-h-[65vh]">
            {/* placeholder or table */}
            {selectedDate ? (
              <>
                <h3 className="text-lg font-bold">{selectedDate} {t('detailed_record')}</h3>
                <DateRecordsTable date={selectedDate} />
              </>
            ) : (
              <div className="flex items-center justify-center h-48">
                <p className="text-gray-400 text-lg">{t('click_date_guide')}</p>
              </div>
            )}
          </div>

          {/* Calendar 오른쪽 */}
          <div className="flex-shrink-0 space-y-4 mt-9 md:mt-11">
            <ProdCalendar selected={selectedDate} onSelect={setSelectedDate} availableDates={reportDates} />

            {/* CSV 버튼들 (캘린더 하단) */}
            <div className="flex justify-center gap-2">
              <input
                id="csvFile"
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const fd = new FormData();
                  fd.append("file", file);
                  try {
                    const { data } = await api.post("/reports/bulk-import/", fd, {
                      headers: { "Content-Type": "multipart/form-data" },
                    });
                    toast.success(`생성 ${data.created}건 / 중복 ${data.skipped}건 / 오류 ${data.errors}건`);
                    // queryClient.invalidateQueries({ queryKey: ["reports"] }); // This line was removed
                    // queryClient.invalidateQueries({ queryKey: ["reports-summary"] }); // This line was removed
                  } catch (err: any) {
                    console.error("CSV upload error:", err);
                    if (err.response?.data?.detail) {
                      toast.error(`CSV 업로드 실패: ${err.response.data.detail}`);
                    } else if (err.response?.status) {
                      toast.error(`CSV 업로드 실패: HTTP ${err.response.status}`);
                    } else {
                      toast.error("CSV 업로드 실패: 네트워크 오류");
                    }
                  } finally {
                    e.target.value = "";
                  }
                }}
              />
              <Button size="sm" variant="ghost" onClick={() => document.getElementById("csvFile")?.click()}>
                {t('csv_upload')}
              </Button>
              <Button size="sm" className="gap-2" onClick={downloadCsv}>
                <DownloadCloud className="h-4 w-4" /> {t('csv_save')}
              </Button>
            </div>
          </div>
        </div>
      </section>

      {/* New Record Section */}
      <section id="new" className="w-full">
        <Card>
          <CardHeader>
            <h2 className="text-xl font-bold text-blue-700">{t('new_rec_title')}</h2>
          </CardHeader>
          <CardContent>
            <RecordForm />
          </CardContent>
        </Card>
      </section>
    </div>
  );
} 