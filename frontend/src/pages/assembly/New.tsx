
import { useState } from 'react';
import { toast } from 'react-toastify';
import AssemblyReportForm from '../../components/AssemblyReportForm';
import AssemblyCSVUpload from '../../components/AssemblyCSVUpload';
import { useCreateAssemblyReport } from '../../hooks/useAssemblyReports';
import { useLang } from '../../i18n';

export default function AssemblyNewPage() {
  const { t } = useLang();
  const [activeTab, setActiveTab] = useState<'form' | 'csv'>('form');
  const createMutation = useCreateAssemblyReport();

  const handleSubmit = async (data: any) => {
    try {
      await createMutation.mutateAsync(data);
      toast.success('가공 생산 보고서가 등록되었습니다.');
    } catch (error: any) {
      toast.error(error.response?.data?.detail || '등록에 실패했습니다.');
    }
  };

  const handleCSVSuccess = () => {
    toast.success('CSV 업로드가 완료되었습니다.');
    // 필요시 데이터 새로고침 로직 추가
  };

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">{t('assembly_production_register')}</h1>
        <p className="text-gray-600 mt-2">{t('assembly_production_register_subtitle')}</p>
      </div>

      {/* 탭 네비게이션 */}
      <div className="mb-6">
        <div className="border-b border-gray-200">
          <nav className="-mb-px flex space-x-8">
            <button
              onClick={() => setActiveTab('form')}
              className={`py-2 px-1 border-b-2 font-medium text-sm ${
                activeTab === 'form'
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              {t('individual_register')}
            </button>
            <button
              onClick={() => setActiveTab('csv')}
              className={`py-2 px-1 border-b-2 font-medium text-sm ${
                activeTab === 'csv'
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              {t('csv_bulk_upload')}
            </button>
          </nav>
        </div>
      </div>

      {/* 탭 컨텐츠 */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        {activeTab === 'form' ? (
          <AssemblyReportForm 
            onSubmit={handleSubmit}
            isLoading={createMutation.isPending}
          />
        ) : (
          <AssemblyCSVUpload onSuccess={handleCSVSuccess} />
        )}
      </div>
    </div>
  );
} 