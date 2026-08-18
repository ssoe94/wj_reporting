import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { toast } from 'react-toastify';
import { useQueryClient } from '@tanstack/react-query';

import { Button } from '../../components/ui/button';
import { useAuth } from '../../contexts/AuthContext';
import { useLang } from '../../i18n';
import api from '../../lib/api';

interface RollbackSourceGroup {
  source_filename: string;
  sheet_name: string;
  count: number;
}

interface RollbackPreview {
  target_date: string;
  count: number;
  manual_reports_preserved: number;
  active_incremental_jobs: number;
  terminal_incremental_jobs: number;
  image_reference_count: number;
  source_groups: RollbackSourceGroup[];
}

interface RollbackResult {
  target_date: string;
  deleted_count: number;
  deleted_image_references: number;
  remote_image_cleanup: 'not_required' | 'deferred';
}

interface QualityExcelRollbackButtonProps {
  disabled?: boolean;
  onRolledBack?: () => void;
}

function errorMessage(error: unknown, fallback: string): string {
  if (typeof error !== 'object' || error === null) return fallback;
  const response = (error as { response?: { data?: unknown } }).response;
  const data = response?.data;
  if (typeof data === 'object' && data !== null) {
    const detail = (data as { error?: unknown; detail?: unknown }).error
      || (data as { detail?: unknown }).detail;
    if (typeof detail === 'string' && detail.trim()) return detail;
  }
  return fallback;
}

export default function QualityExcelRollbackButton({
  disabled = false,
  onRolledBack,
}: QualityExcelRollbackButtonProps) {
  const { user } = useAuth();
  const { lang } = useLang();
  const queryClient = useQueryClient();
  const [working, setWorking] = useState(false);
  const zh = lang === 'zh';

  if (!user?.is_staff) return null;

  const rollback = async () => {
    setWorking(true);
    try {
      const { data: preview } = await api.get<RollbackPreview>('/quality/excel-import/rollback-today/');
      if (preview.active_incremental_jobs > 0) {
        toast.warning(
          zh
            ? 'Excel 后台任务仍在处理中。完成后再取消登记。'
            : 'Excel 백엔드 작업이 처리 중입니다. 완료된 뒤 등록을 취소해 주세요.',
        );
        return;
      }
      if (preview.count === 0 && preview.terminal_incremental_jobs === 0) {
        onRolledBack?.();
        toast.info(zh ? '今天没有通过 Excel 登记的品质报告。' : '오늘 Excel로 등록된 품질 보고서가 없습니다.');
        return;
      }
      const groups = preview.source_groups
        .map((group) => `${group.sheet_name} · ${group.count.toLocaleString()}${zh ? '条' : '건'}`)
        .join('\n');
      const confirmation = zh
        ? [
          `${preview.target_date} 通过 Excel 登记的 ${preview.count.toLocaleString()} 条报告将被删除。`,
          groups,
          preview.image_reference_count > 0
            ? `报告中的 ${preview.image_reference_count.toLocaleString()} 个图片引用将被删除，但远程图片文件需要单独清理。`
            : '这些报告没有远程图片引用。',
          `同时清理 ${preview.terminal_incremental_jobs.toLocaleString()} 个已结束的导入任务。`,
          `手工登记的 ${preview.manual_reports_preserved.toLocaleString()} 条将保留。`,
          '此操作无法撤销。是否继续？',
        ].join('\n\n')
        : [
          `${preview.target_date}에 Excel로 등록된 보고서 ${preview.count.toLocaleString()}건을 삭제합니다.`,
          groups,
          preview.image_reference_count > 0
            ? `보고서의 사진 참조 ${preview.image_reference_count.toLocaleString()}개는 삭제되지만, 원격 사진 파일은 별도 정리가 필요합니다.`
            : '해당 보고서에는 원격 사진 참조가 없습니다.',
          `완료된 가져오기 작업 ${preview.terminal_incremental_jobs.toLocaleString()}개도 함께 정리합니다.`,
          `오늘 수동 등록 ${preview.manual_reports_preserved.toLocaleString()}건은 보존됩니다.`,
          '이 작업은 되돌릴 수 없습니다. 계속할까요?',
        ].join('\n\n');
      if (!window.confirm(confirmation)) return;

      const { data } = await api.post<RollbackResult>('/quality/excel-import/rollback-today/', {
        target_date: preview.target_date,
        expected_count: preview.count,
        confirmation: `DELETE:${preview.target_date}:${preview.count}`,
      });
      await queryClient.invalidateQueries({ queryKey: ['quality-reports'] });
      onRolledBack?.();
      if (data.remote_image_cleanup === 'deferred' && data.deleted_image_references > 0) {
        toast.warning(
          zh
            ? `已删除 ${data.deleted_count.toLocaleString()} 条报告。${data.deleted_image_references.toLocaleString()} 个远程图片文件仍需单独清理。`
            : `보고서 ${data.deleted_count.toLocaleString()}건을 삭제했습니다. 원격 사진 ${data.deleted_image_references.toLocaleString()}개는 별도 정리가 필요합니다.`,
        );
      } else {
        toast.success(
          zh
            ? `已删除今天通过 Excel 登记的 ${data.deleted_count.toLocaleString()} 条报告。`
            : `오늘 Excel 등록 보고서 ${data.deleted_count.toLocaleString()}건을 삭제했습니다.`,
        );
      }
    } catch (error) {
      toast.error(errorMessage(
        error,
        zh ? '无法取消今天的 Excel 登记。请刷新后重试。' : '오늘 Excel 등록을 취소하지 못했습니다. 새로고침 후 다시 시도해 주세요.',
      ));
    } finally {
      setWorking(false);
    }
  };

  return (
    <Button
      type="button"
      variant="danger"
      size="sm"
      disabled={disabled || working}
      onClick={() => void rollback()}
    >
      <RotateCcw className={`mr-1.5 h-4 w-4 ${working ? 'animate-spin' : ''}`} aria-hidden="true" />
      {working
        ? (zh ? '确认中…' : '확인 중…')
        : (zh ? '取消今天的 Excel 登记' : '오늘 Excel 등록 취소')}
    </Button>
  );
}
