import { type ChangeEvent, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { DownloadCloud, FilePlus2, History } from 'lucide-react';
import { toast } from 'react-toastify';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import DateRecordsTable from '@/components/DateRecordsTable';
import ProdCalendar from '@/components/ProdCalendar';
import RecordForm from '@/components/RecordForm';
import api from '@/lib/api';
import { useLang } from '@/i18n';
import { useReportDates, useReportSummary } from '@/hooks/useReports';
import { useShanghaiBusinessDate } from '@/shared/hooks/useShanghaiBusinessDate';

interface Props {
  businessDate?: string;
  machineNumber?: number | null;
  onBusinessDateChange?: (date: string) => void;
}

export default function InjectionReportsPanel({ businessDate, machineNumber = null, onBusinessDateChange }: Props) {
  const location = useLocation();
  const newRecordDetails = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (location.hash !== '#new' || !newRecordDetails.current) return;
    newRecordDetails.current.open = true;
    const frame = window.requestAnimationFrame(() => newRecordDetails.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    return () => window.cancelAnimationFrame(frame);
  }, [location.hash]);
  const { lang } = useLang();
  const tx = (ko: string, zh: string) => lang === 'zh' ? zh : ko;
  const currentDate = useShanghaiBusinessDate();
  const [localDate, setLocalDate] = useState(currentDate);
  const selectedDate = businessDate ?? localDate;
  const selectDate = (date: string | null) => {
    if (!date) return;
    setLocalDate(date);
    onBusinessDateChange?.(date);
  };
  const queryClient = useQueryClient();
  const summaryQuery = useReportSummary(selectedDate, machineNumber);
  const datesQuery = useReportDates(machineNumber);
  const reportDates = datesQuery.data ?? [];
  const summary = summaryQuery.isSuccess ? summaryQuery.data : undefined;
  const [downloading, setDownloading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const uploadInFlight = useRef(false);
  const scopeLabel = `${selectedDate} · ${machineNumber == null ? tx('전체 설비', '全部设备') : `${machineNumber}${tx('호기', '号机')}`}`;

  const refreshReportQueries = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['reports'] }),
      queryClient.invalidateQueries({ queryKey: ['reports-summary'] }),
      queryClient.invalidateQueries({ queryKey: ['report-dates'] }),
    ]);
  };

  const handleRecordSaved = (savedDate: string) => {
    selectDate(savedDate);
    void refreshReportQueries();
  };

  const downloadCsv = async () => {
    setDownloading(true);
    try {
      const response = await api.get('/injection/reports/export/', {
        params: { date: selectedDate, ...(machineNumber != null ? { machine_no: machineNumber } : {}) },
        responseType: 'blob',
      });
      const url = URL.createObjectURL(response.data);
      const link = document.createElement('a');
      link.href = url;
      link.download = `injection_manual_${selectedDate}_${machineNumber == null ? 'all' : `imm${String(machineNumber).padStart(2, '0')}`}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error(tx('수기일보 CSV 다운로드 실패', '手工日报 CSV 下载失败'));
    } finally {
      setDownloading(false);
    }
  };

  const handleCsvUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || uploadInFlight.current) return;
    uploadInFlight.current = true;
    setUploading(true);
    const formData = new FormData();
    formData.append('file', file);
    try {
      const { data } = await api.post('/injection/reports/bulk-import/', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      toast.success(tx(`생성 ${data.created}건 / 갱신 ${data.skipped}건 / 오류 ${data.errors}건`, `新增 ${data.created} 条 / 更新 ${data.skipped} 条 / 错误 ${data.errors} 条`));
    } catch {
      toast.error(tx('CSV 업로드 중 오류가 발생했습니다. 일부 행은 반영되었을 수 있으므로 기록을 확인하세요.', 'CSV 上传出错。部分行可能已保存，请先检查记录。'));
    } finally {
      await refreshReportQueries();
      event.target.value = '';
      uploadInFlight.current = false;
      setUploading(false);
    }
  };

  return (
    <div className="space-y-6">
      <section id="records" className="space-y-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="inline-flex items-center gap-2 text-sm font-bold text-sky-700"><History className="h-4 w-4" />{tx('수기일보', '手工日报')}</div>
            <h2 className="mt-2 text-xl font-bold text-slate-900">{scopeLabel}</h2>
            <p className="mt-2 max-w-3xl text-sm text-slate-600">{tx('담당자가 직접 등록하거나 CSV로 가져온 일보입니다. 현장 불량 신고, MES 계수, 관리자 실행 기록은 각각 별도 원천이며 이 수량에 합산되지 않습니다.', '这里仅包含人工登记或 CSV 导入的日报。现场不良申报、MES 计数及管理执行记录属于独立来源，不合并计入此数量。')}</p>
          </div>
          <Button type="button" size="sm" className="gap-2" onClick={downloadCsv} disabled={downloading}>
            <DownloadCloud className="h-4 w-4" />{tx('선택 범위 수기일보 CSV', '导出所选范围手工日报')}
          </Button>
        </div>

        {summaryQuery.isError ? (
          <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            {tx('수기일보 요약 조회에 실패했습니다. 수치를 확인할 수 없습니다.', '手工日报汇总查询失败，无法确认数量。')}
            <Button type="button" size="sm" variant="secondary" className="ml-3" disabled={summaryQuery.isFetching} onClick={() => void summaryQuery.refetch()}>{tx('다시 조회', '重试')}</Button>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              [tx('수기일보 건수', '手工日报条数'), summary?.total_count],
              [tx('수기 계획 수량', '手工计划数量'), summary?.total_plan_qty],
              [tx('수기 실적 수량', '手工实绩数量'), summary?.total_actual_qty],
              [tx('수기 실제불량 수량', '手工实际不良数量'), summary?.total_defect_qty],
            ].map(([label, value]) => <Card key={String(label)} className="border-slate-200 shadow-none"><CardContent className="pt-4"><p className="text-xs text-slate-500">{label}</p><p className="mt-1 text-2xl font-bold text-slate-900">{typeof value === 'number' ? value.toLocaleString() : '—'}</p></CardContent></Card>)}
          </div>
        )}

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_300px]">
          <Card className="min-w-0 border-slate-200 shadow-sm">
            <CardHeader className="pb-3"><h3 className="font-bold text-slate-900">{tx('수기일보 상세', '手工日报明细')}</h3></CardHeader>
            <CardContent><div className="max-h-[62vh] overflow-auto"><DateRecordsTable date={selectedDate} machineNumber={machineNumber} /></div></CardContent>
          </Card>
          <Card className="border-slate-200 shadow-sm">
            <CardHeader className="pb-3"><h3 className="font-bold text-slate-900">{tx('수기일보 날짜 찾기', '查找手工日报日期')}</h3></CardHeader>
            <CardContent className="space-y-3">
              <p className="text-xs text-slate-500">{tx('기록이 없어도 선택 날짜를 유지합니다. 표시된 날짜만 수기일보가 등록된 날짜입니다.', '无记录时仍保留所选日期。标记日期表示已有手工日报。')}</p>
              {datesQuery.isError ? <p role="alert" className="text-sm text-amber-800">{tx('기록 날짜를 불러오지 못했습니다.', '未能加载记录日期。')} <button type="button" className="underline" onClick={() => void datesQuery.refetch()}>{tx('재시도', '重试')}</button></p> : null}
              <Button type="button" size="sm" variant="secondary" disabled={!datesQuery.isSuccess || !reportDates.length} onClick={() => selectDate(reportDates[0])}>{tx('최근 기록일', '最近记录日')}{datesQuery.isSuccess && reportDates[0] ? ` · ${reportDates[0]}` : ''}</Button>
              <ProdCalendar selected={selectedDate} onSelect={selectDate} availableDates={reportDates} />
            </CardContent>
          </Card>
        </div>
      </section>

      <details ref={newRecordDetails} id="new" className="rounded-xl border border-slate-200 bg-white p-5">
        <summary className="cursor-pointer font-bold text-slate-900"><FilePlus2 className="mr-2 inline h-5 w-5 text-blue-600" />{tx('수기일보 신규 입력 / CSV 가져오기', '新增手工日报 / 导入 CSV')}</summary>
        <p className="mt-3 text-sm text-slate-600">{tx('현장 신고를 다시 입력하는 곳이 아닙니다. 대조 후 별도로 관리할 수기일보가 있을 때 사용하세요. 신규 입력의 날짜·설비는 아래 작성 대상에서 확인합니다.', '此处无需重复录入现场申报。仅在核对后需要独立手工日报时使用。请以下方填写的日期及设备为准。')}</p>
        <div className="mt-5"><RecordForm reportDate={selectedDate} machineNumber={machineNumber} onSaved={handleRecordSaved} /></div>
        <div className="mt-6 border-t border-slate-200 pt-4">
          <p className="mb-3 text-sm text-slate-600">{tx('CSV 가져오기는 파일 안의 날짜·설비를 사용합니다. 같은 날짜·설비·품번의 기존 일보는 갱신됩니다. 위 조회 범위로 제한되지 않습니다.', 'CSV 按文件中的日期及设备导入。同日期、设备和品号的已有日报会被更新，不受上方查询范围限制。')}</p>
          <input id="injectionReportsCsvFile" type="file" accept=".csv,text/csv" className="hidden" onChange={handleCsvUpload} disabled={uploading} />
          <Button type="button" size="sm" variant="secondary" disabled={uploading} onClick={() => document.getElementById('injectionReportsCsvFile')?.click()}>{uploading ? tx('가져오는 중…', '导入中…') : tx('CSV 가져오기', '导入 CSV')}</Button>
        </div>
      </details>
    </div>
  );
}
