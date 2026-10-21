import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { AlertTriangle } from 'lucide-react';

interface DuplicateSetupData {
  machine_no: number;
  part_no: string;
  target_cycle_time: number;
  existing_setup?: any;
}

interface DuplicateSetupModalProps {
  isOpen: boolean;
  onClose: () => void;
  duplicateItems: DuplicateSetupData[];
  onCreateNewVersion: (items: DuplicateSetupData[]) => void;
  onUpdateExisting: (items: DuplicateSetupData[]) => void;
}

export default function DuplicateSetupModal({
  isOpen,
  onClose,
  duplicateItems,
  onCreateNewVersion,
  onUpdateExisting
}: DuplicateSetupModalProps) {
  const [loading, setLoading] = useState(false);
  const [selectedAction, setSelectedAction] = useState<'new' | 'update' | null>(null);

  const handleAction = async (action: 'new' | 'update') => {
    setLoading(true);
    setSelectedAction(action);

    try {
      if (action === 'new') {
        await onCreateNewVersion(duplicateItems);
      } else {
        await onUpdateExisting(duplicateItems);
      }
      onClose();
    } catch (error) {
      console.error('Action failed:', error);
    } finally {
      setLoading(false);
      setSelectedAction(null);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-[var(--wj-surface-solid)] bg-opacity-30 flex items-center justify-center z-50">
      <div className="bg-[var(--wj-surface-solid)] rounded-lg p-6 w-full max-w-3xl mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center gap-3 mb-6">
          <AlertTriangle className="w-6 h-6 text-[var(--wj-warning)]" />
          <h3 className="text-xl font-semibold text-[var(--wj-text)]">
            중복 설정 확인
          </h3>
        </div>

        <div className="mb-6">
          <p className="text-[var(--wj-text)] mb-4">
            다음 설정들이 이미 존재합니다. 어떻게 처리하시겠습니까?
          </p>

          <div className="bg-[var(--wj-warning-bg)] border border-[var(--wj-warning-border)] rounded-lg p-4">
            <div className="space-y-2">
              {duplicateItems.map((item, index) => (
                <div key={index} className="flex items-center justify-between py-2 border-b border-[var(--wj-warning-border)] last:border-b-0">
                  <div className="flex items-center gap-4">
                    <span className="font-medium text-[var(--wj-warning)]">
                      {item.machine_no}호기
                    </span>
                    <span className="text-[var(--wj-warning)]">
                      {item.part_no}
                    </span>
                    <span className="text-sm text-[var(--wj-warning)]">
                      설정C/T: {item.target_cycle_time}초
                    </span>
                  </div>
                  {item.existing_setup && (
                    <div className="text-xs text-[var(--wj-warning)]">
                      기존: {item.existing_setup.target_cycle_time}초
                      ({new Date(item.existing_setup.setup_date).toLocaleDateString()})
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="mb-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="border border-[var(--wj-border)] rounded-lg p-4 bg-[var(--wj-bg-strong)]">
              <h4 className="font-medium text-[var(--wj-accent-strong)] mb-2">새 버전으로 생성</h4>
              <p className="text-sm text-[var(--wj-accent-strong)] mb-3">
                기존 설정을 유지하고 새로운 설정을 추가합니다.
                이전 설정 이력이 보존됩니다.
              </p>
              <ul className="text-xs text-[var(--wj-accent-strong)] space-y-1">
                <li>• 기존 설정: "대체됨" 상태로 변경</li>
                <li>• 새 설정: 새로운 레코드로 생성</li>
                <li>• 변경 이력 완전 보존</li>
              </ul>
            </div>

            <div className="border border-[var(--wj-success-border)] rounded-lg p-4 bg-[var(--wj-success-bg)]">
              <h4 className="font-medium text-[var(--wj-success)] mb-2">기존 설정 수정</h4>
              <p className="text-sm text-[var(--wj-success)] mb-3">
                현재 설정을 직접 수정합니다.
                빠르고 간단한 업데이트입니다.
              </p>
              <ul className="text-xs text-[var(--wj-success)] space-y-1">
                <li>• 기존 레코드를 직접 수정</li>
                <li>• 설정 날짜는 현재로 업데이트</li>
                <li>• 간단한 수정 사항에 적합</li>
              </ul>
            </div>
          </div>
        </div>

        <div className="flex gap-3 justify-end">
          <Button
            type="button"
            variant="secondary"
            onClick={onClose}
            disabled={loading}
          >
            취소
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => handleAction('update')}
            disabled={loading}
            className="border-[var(--wj-success-border)] text-[var(--wj-success)] hover:bg-[var(--wj-success-bg)]"
          >
            {loading && selectedAction === 'update' ? '수정 중...' : '기존 설정 수정'}
          </Button>
          <Button
            type="button"
            onClick={() => handleAction('new')}
            disabled={loading}
            className="bg-[var(--wj-accent-strong)] hover:bg-[var(--wj-accent-strong)]"
          >
            {loading && selectedAction === 'new' ? '생성 중...' : '새 버전으로 생성'}
          </Button>
        </div>
      </div>
    </div>
  );
}
