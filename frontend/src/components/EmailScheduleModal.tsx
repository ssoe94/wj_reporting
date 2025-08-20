import React, { useState } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { useEmailSchedule } from '../hooks/useDailyReport';
import { toast } from 'react-toastify';

interface EmailScheduleModalProps {
  isOpen: boolean;
  onClose: () => void;
  selectedDate: string;
}

export default function EmailScheduleModal({ isOpen, onClose, selectedDate }: EmailScheduleModalProps) {
  const [recipients, setRecipients] = useState<string>('');
  const [scheduledAt, setScheduledAt] = useState<string>('');
  const { scheduleEmail, isScheduling } = useEmailSchedule();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!recipients.trim()) {
      toast.error('수신자 이메일을 입력해주세요.');
      return;
    }

    const recipientList = recipients.split(',').map(email => email.trim()).filter(email => email);
    
    try {
      await scheduleEmail({
        date: selectedDate,
        recipients: recipientList,
        scheduled_at: scheduledAt || undefined,
      });
      
      toast.success('이메일 발송이 예약되었습니다. (개발 중 - 실제 발송되지 않습니다)');
      onClose();
    } catch (error) {
      toast.error('이메일 발송 예약에 실패했습니다.');
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 w-full max-w-md mx-4">
        {/* 개발 중 배너 */}
        <div className="bg-yellow-100 border border-yellow-400 text-yellow-800 px-4 py-3 rounded mb-4">
          <div className="flex items-center">
            <svg className="w-5 h-5 mr-2" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
            <span className="font-medium">개발 중</span>
          </div>
          <p className="text-sm mt-1">이메일 발송 기능은 현재 개발 중입니다. 실제 발송되지 않으며 로그만 출력됩니다.</p>
        </div>

        <h2 className="text-xl font-semibold mb-4">이메일 발송 예약</h2>
        
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label htmlFor="date">날짜</Label>
            <Input
              id="date"
              type="text"
              value={selectedDate}
              disabled
              className="bg-gray-50"
            />
          </div>

          <div>
            <Label htmlFor="recipients">수신자 이메일</Label>
            <Input
              id="recipients"
              type="text"
              value={recipients}
              onChange={(e) => setRecipients(e.target.value)}
              placeholder="email1@example.com, email2@example.com"
              required
            />
            <p className="text-sm text-gray-500 mt-1">
              여러 이메일은 쉼표(,)로 구분하세요
            </p>
          </div>

          <div>
            <Label htmlFor="scheduledAt">발송 예정 시간 (선택사항)</Label>
            <Input
              id="scheduledAt"
              type="datetime-local"
              value={scheduledAt}
              onChange={(e) => setScheduledAt(e.target.value)}
            />
            <p className="text-sm text-gray-500 mt-1">
              비워두면 즉시 발송됩니다
            </p>
          </div>

          <div className="flex gap-2 pt-4">
            <Button
              type="button"
              onClick={onClose}
              variant="secondary"
              className="flex-1"
            >
              취소
            </Button>
            <Button
              type="submit"
              disabled={isScheduling}
              className="flex-1 bg-yellow-500 hover:bg-yellow-600 text-white font-bold"
            >
              {isScheduling ? '예약 중...' : '예약하기'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
} 