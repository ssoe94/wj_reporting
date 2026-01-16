import React, { useState, FormEvent } from 'react';
import { toast } from 'react-toastify';
import { AxiosError } from 'axios';
import { CloudUpload, CalendarDays, Loader2 } from 'lucide-react';
import { useLang } from '../../i18n';
import { Button } from '../ui/button';
import { uploadProductionPlanFile } from '../../lib/api';

type PlanType = 'injection' | 'machining';

interface UploadCardProps {
  planType: PlanType;
  onUploadSuccess: () => void;
  className?: string;
}

const UploadCard: React.FC<UploadCardProps> = ({ planType, onUploadSuccess, className }) => {
  const { t } = useLang();
  const [targetDate, setTargetDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDragActive, setIsDragActive] = useState(false);

  const descriptionText = planType === 'injection' ? t('plan_form_description_injection') : t('plan_form_description_machining');
  const fileHintText = planType === 'injection' ? t('plan_form_file_hint_injection') : t('plan_form_file_hint_machining');
  const title = planType === 'injection' ? t('plan_toggle_injection') : t('plan_toggle_machining');

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedFile) {
      toast.error(t('plan_form_file_required')); // A key that should exist
      return;
    }
    try {
      setIsSubmitting(true);
      await uploadProductionPlanFile(selectedFile, planType, targetDate);
      toast.success(t('plan_upload_success')); // A key that should exist
      onUploadSuccess(); // Notify parent
      setSelectedFile(null); // Clear file input
    } catch (error) {
      const err = error as AxiosError<{ detail?: string, error?: string }>;
      toast.error(err.response?.data?.detail || err.response?.data?.error || err.message || t('plan_upload_error'));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <section className={`bg-white rounded-xl shadow p-6 flex flex-col h-full ${className ?? ''}`}>
      <div className="flex items-start gap-3">
        <CloudUpload className="w-6 h-6 text-blue-500 mt-1" />
        <div>
          <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
          <p className="text-sm text-gray-500">{descriptionText}</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4 flex-1 flex flex-col mt-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            {t('plan_form_date_label')}
          </label>
          <div className="relative">
            <input
              type="date"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500"
              value={targetDate}
              onChange={(event) => setTargetDate(event.target.value)}
            />
            <CalendarDays className="w-4 h-4 text-gray-400 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1 flex items-center gap-1">
            {t('plan_form_file_label')}
            <span className="flex items-center gap-0.5 text-[11px] text-gray-400 font-normal">
              <span className="text-[12px] leading-none">ⓘ</span>
              {fileHintText}
            </span>
          </label>
          <input
            type="file"
            accept=".xlsx,.xls"
            key={selectedFile ? 'file-selected' : 'no-file'} // Force re-render to clear file name
            className="block w-full text-sm text-gray-600 file:mr-4 file:rounded-md file:border-0 file:bg-blue-50 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-blue-600 hover:file:bg-blue-100"
            onChange={(event) => setSelectedFile(event.target.files?.[0] || null)}
          />
          {selectedFile && (
            <p className="mt-1 text-sm text-gray-700">{selectedFile.name}</p>
          )}
          <div
            className={`mt-3 flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed px-3 py-7 text-xs transition ${
              isDragActive ? 'border-blue-400 bg-blue-50 text-blue-600' : 'border-gray-300 bg-gray-50 text-gray-500'
            }`}
            onDragOver={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setIsDragActive(true);
            }}
            onDragLeave={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setIsDragActive(false);
            }}
            onDrop={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setIsDragActive(false);
              const file = event.dataTransfer.files?.[0];
              if (file) {
                setSelectedFile(file);
              }
            }}
          >
            <span>
              {t('plan_drag_drop_hint') ||
                '여기로 파일을 끌어다 놓거나, 위의 파일 선택을 눌러 업로드하세요.'}
            </span>
          </div>
        </div>

        <div className="mt-auto">
          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {isSubmitting ? t('plan_uploading') : t('plan_upload_button')}
          </Button>
        </div>
      </form>
    </section>
  );
};

export default UploadCard;
