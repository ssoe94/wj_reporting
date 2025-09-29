import { useState } from 'react';
import { useLang } from '@/i18n';
import { Dialog } from '@headlessui/react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { X, TestTube } from 'lucide-react';
import api from '@/lib/api';
import { toast } from 'react-toastify';

interface TestRecordModalProps {
  setup: {
    id: number;
    part_no: string;
    machine_no: number;
    target_cycle_time: number;
    test_records: any[];
  };
  onClose: () => void;
  onSuccess: () => void;
}

export default function TestRecordModal({ setup, onClose, onSuccess }: TestRecordModalProps) {
  const { t } = useLang();
  const [testData, setTestData] = useState({
    actual_cycle_time: '',
    test_qty: '1',
    quality_ok: true,
    note: '',
  });
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const actualCycleTime = parseInt(testData.actual_cycle_time);
    const testQty = parseInt(testData.test_qty);

    if (isNaN(actualCycleTime) || actualCycleTime < 1) {
      toast.error('올바른 실제 사이클 타임을 입력해주세요.');
      return;
    }

    if (isNaN(testQty) || testQty < 1) {
      toast.error('올바른 테스트 수량을 입력해주세요.');
      return;
    }

    setIsSubmitting(true);
    try {
      await api.post(`/injection/setup/${setup.id}/add-test/`, {
        actual_cycle_time: actualCycleTime,
        test_qty: testQty,
        quality_ok: testData.quality_ok,
        note: testData.note,
      });

      toast.success('테스트 기록이 추가되었습니다.');
      onSuccess();
      onClose();
    } catch (error: any) {
      const errorMessage = error?.response?.data?.error || '테스트 기록 추가에 실패했습니다.';
      toast.error(errorMessage);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleInputChange = (field: string, value: string | boolean) => {
    setTestData(prev => ({ ...prev, [field]: value }));
  };

  return (
    <Dialog open={true} onClose={onClose} className="relative z-50">
      <div className="fixed inset-0 bg-black/30" aria-hidden="true" />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <Dialog.Panel className="bg-white rounded-lg shadow-xl w-full max-w-md">
          <div className="flex items-center justify-between p-6 border-b">
            <Dialog.Title className="text-lg font-semibold text-gray-900">
              {t('test_modal.title')}
            </Dialog.Title>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="p-6">
            {/* 셋업 정보 */}
            <div className="mb-6 p-4 bg-gray-50 rounded-lg">
              <div className="text-sm text-gray-600 space-y-1">
                <p><strong>{t('test_modal.machine_label')}:</strong> {setup.machine_no}번기</p>
                <p><strong>{t('test_modal.part_no_label')}:</strong> {setup.part_no}</p>
                <p><strong>{t('test_modal.target_ct_label')}:</strong> {setup.target_cycle_time}초</p>
                <p><strong>{t('test_modal.existing_tests_label')}:</strong> {setup.test_records.length}회</p>
              </div>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              {/* 실제 사이클 타임 */}
              <div>
                <Label htmlFor="actual_cycle_time">{t('test_modal.actual_ct_label')}</Label>
                <Input
                  id="actual_cycle_time"
                  type="number"
                  min="1"
                  value={testData.actual_cycle_time}
                  onChange={(e) => handleInputChange('actual_cycle_time', e.target.value)}
                  placeholder={t('test_modal.actual_ct_placeholder', { time: setup.target_cycle_time })}
                  required
                />
              </div>

              {/* 테스트 수량 */}
              <div>
                <Label htmlFor="test_qty">{t('test_modal.test_qty_label')}</Label>
                <Input
                  id="test_qty"
                  type="number"
                  min="1"
                  value={testData.test_qty}
                  onChange={(e) => handleInputChange('test_qty', e.target.value)}
                />
              </div>

              {/* 품질 상태 */}
              <div>
                <Label>{t('test_modal.quality_status_label')}</Label>
                <div className="flex space-x-4 mt-2">
                  <label className="flex items-center">
                    <input
                      type="radio"
                      name="quality_ok"
                      checked={testData.quality_ok === true}
                      onChange={() => handleInputChange('quality_ok', true)}
                      className="mr-2"
                    />
                    {t('test_modal.quality_ok')}
                  </label>
                  <label className="flex items-center">
                    <input
                      type="radio"
                      name="quality_ok"
                      checked={testData.quality_ok === false}
                      onChange={() => handleInputChange('quality_ok', false)}
                      className="mr-2"
                    />
                    {t('test_modal.quality_fail')}
                  </label>
                </div>
              </div>

              {/* 테스트 비고 */}
              <div>
                <Label htmlFor="note">{t('test_modal.note_label')}</Label>
                <Textarea
                  id="note"
                  value={testData.note}
                  onChange={(e) => handleInputChange('note', e.target.value)}
                  placeholder={t('test_modal.note_placeholder')}
                  rows={3}
                />
              </div>

              <div className="flex justify-end space-x-3 pt-4">
                <Button type="button" variant="secondary" onClick={onClose}>
                  {t('test_modal.cancel_button')}
                </Button>
                <Button
                  type="submit"
                  disabled={isSubmitting}
                  className="flex items-center gap-2"
                >
                  <TestTube className="w-4 h-4" />
                  {isSubmitting ? t('test_modal.adding_button') : t('test_modal.add_button')}
                </Button>
              </div>
            </form>
          </div>
        </Dialog.Panel>
      </div>
    </Dialog>
  );
}