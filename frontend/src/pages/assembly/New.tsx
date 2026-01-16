
import { toast } from 'react-toastify';
import { useNavigate } from 'react-router-dom';
import AssemblyReportForm from '../../components/AssemblyReportForm';
import { useCreateAssemblyReport } from '../../hooks/useAssemblyReports';
import { useLang } from '../../i18n';

export default function AssemblyNewPage() {
  const { t } = useLang();
  const createMutation = useCreateAssemblyReport();
  const navigate = useNavigate();

  const handleSubmit = async (data: any) => {
    try {
      const response = await createMutation.mutateAsync(data);
      toast.success(t('save_success'));

      // 저장된 날짜 정보 가져오기
      const date = response?.date || data?.date;

      // 쿼리 무효화하여 캘린더와 상세기록 업데이트
      // navigate 대신 쿼리 무효화만 하고 섹션 스크롤
      if (date) {
        // URL에 date 파라미터 추가하고 records 섹션으로 이동
        navigate(`/assembly?date=${encodeURIComponent(date)}#records`, { replace: true });
      } else {
        navigate(`/assembly#records`, { replace: true });
      }
    } catch (error: any) {
      toast.error(error.response?.data?.detail || t('save_fail'));
    }
  };

  return (
    <div className="p-6">
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <AssemblyReportForm
          onSubmit={handleSubmit}
          isLoading={createMutation.isPending}
        />
      </div>
    </div>
  );
} 