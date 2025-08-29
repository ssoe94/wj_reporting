
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
      await createMutation.mutateAsync(data);
      toast.success('가공 생산 보고서가 등록되었습니다.');
      const date = data?.date;
      if (date) {
        navigate(`/assembly?date=${encodeURIComponent(date)}#records`, { replace: true });
      } else {
        navigate(`/assembly#records`, { replace: true });
      }
    } catch (error: any) {
      toast.error(error.response?.data?.detail || '등록에 실패했습니다.');
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