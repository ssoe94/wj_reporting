import { useState, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Save } from 'lucide-react';
import api from '@/lib/api';
import { toast } from 'react-toastify';
import UnifiedPartSelector from '@/components/UnifiedPartSelector';

interface CycleTimeFormProps {
  onSuccess: () => void;
}

export default function CycleTimeForm({ onSuccess }: CycleTimeFormProps) {
  const [formData, setFormData] = useState({
    machine_no: '',
    part_no: '',
    target_cycle_time: '',
    note: '',
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [existingCycleTime, setExistingCycleTime] = useState<number | null>(null);
  const partSelectorRef = useRef<any>(null);

  const handleInputChange = (field: string, value: string | number) => {
    setFormData(prev => ({
      ...prev,
      [field]: value
    }));
  };

  const handlePartSelect = async (partNo: string) => {
    setFormData(prev => ({
      ...prev,
      part_no: partNo
    }));

    // 기존 사이클 타임 조회
    try {
      const response = await api.get('/injection/parts/', {
        params: { search: partNo }
      });

      const part = response.data.results.find((p: any) =>
        p.part_no.toUpperCase() === partNo.toUpperCase()
      );

      if (part && part.cycle_time_sec) {
        setExistingCycleTime(part.cycle_time_sec);
        if (!formData.target_cycle_time) {
          setFormData(prev => ({
            ...prev,
            target_cycle_time: part.cycle_time_sec.toString()
          }));
        }
      } else {
        setExistingCycleTime(null);
      }
    } catch (error) {
      console.error('기존 사이클 타임 조회 실패:', error);
      setExistingCycleTime(null);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.machine_no || !formData.part_no || !formData.target_cycle_time) {
      toast.error('필수 항목을 모두 입력해주세요.');
      return;
    }

    const machineNo = parseInt(formData.machine_no);
    const targetCycleTime = parseInt(formData.target_cycle_time);

    if (isNaN(machineNo) || machineNo < 1) {
      toast.error('올바른 사출기 번호를 입력해주세요.');
      return;
    }

    if (isNaN(targetCycleTime) || targetCycleTime < 1) {
      toast.error('올바른 사이클 타임을 입력해주세요.');
      return;
    }

    setIsSubmitting(true);
    try {
      await api.post('/injection/setup/', {
        machine_no: machineNo,
        part_no: formData.part_no.toUpperCase(),
        target_cycle_time: targetCycleTime,
        note: formData.note,
      });

      toast.success('사이클 타임 셋업이 생성되었습니다.');

      // 폼 초기화
      setFormData({
        machine_no: '',
        part_no: '',
        target_cycle_time: '',
        note: '',
      });
      setExistingCycleTime(null);
      if (partSelectorRef.current) {
        partSelectorRef.current.clearSelection();
      }

      onSuccess();
    } catch (error: any) {
      const errorMessage = error?.response?.data?.error || '셋업 생성에 실패했습니다.';
      toast.error(errorMessage);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Card className="p-6 max-w-2xl mx-auto">
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-gray-900 mb-2">새 사이클 타임 셋업</h2>
        <p className="text-gray-600">사출기에서 사용할 사이클 타임을 설정합니다.</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* 사출기 번호 */}
        <div>
          <Label htmlFor="machine_no">사출기 번호 *</Label>
          <Input
            id="machine_no"
            type="number"
            min="1"
            value={formData.machine_no}
            onChange={(e) => handleInputChange('machine_no', e.target.value)}
            placeholder="예: 1"
            required
          />
        </div>

        {/* Part No. 선택 */}
        <div>
          <Label htmlFor="part_no">Part No. *</Label>
          <UnifiedPartSelector
            onPartChange={handlePartSelect}
            placeholder="Part No.를 입력하세요"
          />
          {existingCycleTime && (
            <p className="mt-1 text-sm text-blue-600">
              현재 설정된 사이클 타임: {existingCycleTime}초
            </p>
          )}
        </div>

        {/* 목표 사이클 타임 */}
        <div>
          <Label htmlFor="target_cycle_time">목표 사이클 타임 (초) *</Label>
          <Input
            id="target_cycle_time"
            type="number"
            min="1"
            value={formData.target_cycle_time}
            onChange={(e) => handleInputChange('target_cycle_time', e.target.value)}
            placeholder="예: 45"
            required
          />
          <p className="mt-1 text-sm text-gray-500">
            새로 설정하고자 하는 사이클 타임을 초 단위로 입력하세요.
          </p>
        </div>

        {/* 설정 비고 */}
        <div>
          <Label htmlFor="note">설정 비고</Label>
          <Textarea
            id="note"
            value={formData.note}
            onChange={(e) => handleInputChange('note', e.target.value)}
            placeholder="설정 사유나 특이사항을 입력하세요"
            rows={3}
          />
        </div>

        {/* 제출 버튼 */}
        <div className="flex justify-end space-x-3">
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setFormData({
                machine_no: '',
                part_no: '',
                target_cycle_time: '',
                note: '',
              });
              setExistingCycleTime(null);
              if (partSelectorRef.current) {
                partSelectorRef.current.clearSelection();
              }
            }}
          >
            초기화
          </Button>
          <Button
            type="submit"
            disabled={isSubmitting}
            className="flex items-center gap-2"
          >
            <Save className="w-4 h-4" />
            {isSubmitting ? '생성 중...' : '셋업 생성'}
          </Button>
        </div>
      </form>
    </Card>
  );
}