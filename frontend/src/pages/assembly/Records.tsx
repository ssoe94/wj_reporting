
import { useState } from 'react';
import { toast } from 'react-toastify';
import { Button } from '../../components/ui/button';
import { useExportAssemblyReports } from '../../hooks/useAssemblyReports';
import AssemblyProdCalendar from '../../components/AssemblyProdCalendar';
import AssemblyDateRecordsTable from '../../components/AssemblyDateRecordsTable';
import { DownloadCloud } from 'lucide-react';
import { api } from '../../lib/api';

export default function AssemblyRecordsPage() {
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const exportMutation = useExportAssemblyReports();

  const handleExport = async () => {
    try {
      await exportMutation.mutateAsync({});
      toast.success('CSV 파일이 다운로드되었습니다.');
    } catch (error) {
      toast.error('내보내기에 실패했습니다.');
    }
  };

  const handleCsvUpload = async (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    try {
      const { data } = await api.post('/assembly/reports/bulk-import/', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      toast.success(`생성 ${data.created}건 / 중복 ${data.skipped}건 / 오류 ${data.errors}건`);
    } catch (err: any) {
      console.error('CSV upload error:', err);
      if (err.response?.data?.detail) {
        toast.error(`CSV 업로드 실패: ${err.response.data.detail}`);
      } else {
        toast.error('CSV 업로드 실패');
      }
    }
  };


  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">가공 생산 기록</h1>
        <p className="text-gray-600 mt-2">가공 생산 보고서 조회 및 관리</p>
      </div>

      <div className="md:flex gap-6">
        {/* 왼쪽: 테이블 영역 */}
        <div className="flex-1 space-y-4 overflow-auto max-h-[65vh]">
          {selectedDate ? (
            <>
              <h3 className="text-lg font-bold">{selectedDate} 상세 기록</h3>
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

          {/* CSV 버튼들 (캘린더 하단) */}
          <div className="flex justify-center gap-2">
            <input
              id="csvFile"
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                  handleCsvUpload(file);
                  e.target.value = '';
                }
              }}
            />
            <Button size="sm" variant="ghost" onClick={() => document.getElementById('csvFile')?.click()}>
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