
import { toast } from 'react-toastify';
import { useNavigate } from 'react-router-dom';
import AssemblyReportForm from '../../components/AssemblyReportForm';
import { useCreateAssemblyReport } from '../../hooks/useAssemblyReports';
import { useLang } from '../../i18n';
import { ClipboardPlus } from 'lucide-react';

export default function AssemblyNewPage() {
  const { t, lang } = useLang();
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
    <div className="assembly-new-section">
      <div className="assembly-new-section__heading">
        <span aria-hidden="true"><ClipboardPlus /></span>
        <div>
          <h2>{lang === 'zh' ? '新增加工生产记录' : '가공 생산 기록 등록'}</h2>
          <p>
            {lang === 'zh'
              ? '所有输入项使用相同高度，按生产流程依次填写。'
              : '입력 규격을 맞춰 생산 흐름에 따라 순서대로 기록합니다.'}
          </p>
        </div>
      </div>
      <div className="assembly-new-section__form">
        <AssemblyReportForm
          onSubmit={handleSubmit}
          isLoading={createMutation.isPending}
        />
      </div>
    </div>
  );
}
