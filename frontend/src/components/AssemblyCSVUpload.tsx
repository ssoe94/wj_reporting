import React, { useState } from 'react';
import { Card, CardHeader, CardContent } from './ui/card';
import { Button } from './ui/button';
import axios from 'axios';

interface ValidationResult {
  valid_data: Array<{
    row_number: number;
    data: any;
  }>;
  auto_corrected: Array<{
    row_number: number;
    data: any;
    message: string;
  }>;
  new_parts: Array<{
    row_number: number;
    data: any;
    message: string;
  }>;
  errors: Array<{
    row_number: number;
    data: any;
    errors: string | string[];
  }>;
  total_rows: number;
}

interface NewPartInfo {
  part_no: string;
  model_code: string;
  description?: string;
  process_type?: string;
  material_type?: string;
  standard_cycle_time?: number;
  standard_worker_count?: number;
}

interface AssemblyCSVUploadProps {
  onSuccess?: () => void;
}

export default function AssemblyCSVUpload({ onSuccess }: AssemblyCSVUploadProps) {
  const [file, setFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null);
  const [showNewPartModal, setShowNewPartModal] = useState(false);
  const [newPartsInfo, setNewPartsInfo] = useState<NewPartInfo[]>([]);
  const [currentNewPartIndex, setCurrentNewPartIndex] = useState(0);

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0];
    if (selectedFile) {
      setFile(selectedFile);
      setValidationResult(null);
    }
  };

  const handlePreview = async () => {
    if (!file) return;

    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.append('csv_file', file);

      const response = await axios.post('/assembly/reports/csv-preview/', formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      });

      setValidationResult(response.data);

      // 신규 Part가 있으면 모달 표시
      if (response.data.new_parts.length > 0) {
        const newParts = response.data.new_parts.map((item: any) => ({
          part_no: item.data.part_no,
          model_code: item.data.model,
          description: '',
          process_type: '',
          material_type: '',
          standard_cycle_time: undefined,
          standard_worker_count: 1,
        }));
        setNewPartsInfo(newParts);
        setCurrentNewPartIndex(0);
        setShowNewPartModal(true);
      }
    } catch (error: any) {
      console.error('CSV 미리보기 실패:', error);
      alert(`CSV 미리보기 실패: ${error.response?.data?.detail || error.message}`);
    } finally {
      setIsUploading(false);
    }
  };

  const handleFinalImport = async () => {
    if (!validationResult) return;

    setIsUploading(true);
    try {
      const allValidData = [
        ...validationResult.valid_data,
        ...validationResult.auto_corrected,
        ...validationResult.new_parts,
      ];

      const response = await axios.post('/assembly/reports/csv-import/', {
        validated_data: allValidData,
        new_parts_info: newPartsInfo,
      });

      if (response.data.success) {
        alert(`성공적으로 업로드되었습니다!\n생산기록: ${response.data.created_reports}개\n신규 Part: ${response.data.created_parts}개`);
        setFile(null);
        setValidationResult(null);
        setNewPartsInfo([]);
        setShowNewPartModal(false);
        if (onSuccess) onSuccess();
      } else {
        alert(`업로드 중 오류 발생:\n${response.data.errors.join('\n')}`);
      }
    } catch (error: any) {
      console.error('CSV 업로드 실패:', error);
      alert(`CSV 업로드 실패: ${error.response?.data?.detail || error.message}`);
    } finally {
      setIsUploading(false);
    }
  };

  const handleNewPartSubmit = () => {
    if (currentNewPartIndex < newPartsInfo.length - 1) {
      setCurrentNewPartIndex(currentNewPartIndex + 1);
    } else {
      setShowNewPartModal(false);
    }
  };

  const updateNewPartInfo = (field: keyof NewPartInfo, value: any) => {
    const updated = [...newPartsInfo];
    updated[currentNewPartIndex] = {
      ...updated[currentNewPartIndex],
      [field]: value,
    };
    setNewPartsInfo(updated);
  };

  

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <h3 className="text-lg font-medium">CSV 업로드</h3>
          <p className="text-sm text-[var(--wj-muted)]">
            생산 기록을 CSV 파일로 대량 업로드할 수 있습니다.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 파일 선택 */}
          <div>
            <label className="block text-sm font-medium text-[var(--wj-text)] mb-2">
              CSV 파일 선택
            </label>
            <input
              type="file"
              accept=".csv"
              onChange={handleFileSelect}
              className="block w-full text-sm text-[var(--wj-muted)] file:mr-4 file:py-2 file:px-4 file:rounded file:border-0 file:text-sm file:font-semibold file:bg-[var(--wj-bg-strong)] file:text-[var(--wj-accent-strong)] hover:file:bg-[var(--wj-surface-muted)]"
            />
            {file && (
              <p className="text-sm text-[var(--wj-muted)] mt-1">
                선택된 파일: {file.name}
              </p>
            )}
          </div>

          {/* 필수 컬럼 안내 */}
          <div className="bg-[var(--wj-bg-strong)] p-3 rounded">
            <p className="text-sm text-[var(--wj-accent-strong)] font-medium">필수 컬럼:</p>
            <p className="text-xs text-[var(--wj-accent-strong)]">
              date, part_no, model, plan_qty, actual_qty
            </p>
            <p className="text-sm text-[var(--wj-accent-strong)] font-medium mt-1">선택 컬럼:</p>
            <p className="text-xs text-[var(--wj-accent-strong)]">
              line_no, input_qty, injection_defect, outsourcing_defect, processing_defect, operation_time, total_time, idle_time, workers, note
            </p>
          </div>

          {/* 미리보기 버튼 */}
          <Button
            onClick={handlePreview}
            disabled={!file || isUploading}
            className="w-full"
          >
            {isUploading ? '검증 중...' : '미리보기 및 검증'}
          </Button>
        </CardContent>
      </Card>

      {/* 검증 결과 */}
      {validationResult && (
        <Card>
          <CardHeader>
            <h3 className="text-lg font-medium">검증 결과</h3>
            <div className="grid grid-cols-4 gap-4 text-sm">
              <div className="text-[var(--wj-success)]">
                ✅ 정상: {validationResult.valid_data.length}건
              </div>
              <div className="text-[var(--wj-warning)]">
                🔄 자동보정: {validationResult.auto_corrected.length}건
              </div>
              <div className="text-[var(--wj-accent-strong)]">
                ➕ 신규: {validationResult.new_parts.length}건
              </div>
              <div className="text-[var(--wj-danger)]">
                ❌ 오류: {validationResult.errors.length}건
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* 자동 보정된 항목들 */}
            {validationResult.auto_corrected.length > 0 && (
              <div>
                <h4 className="font-medium text-[var(--wj-warning)] mb-2">자동 보정된 항목</h4>
                <div className="max-h-32 overflow-y-auto space-y-1">
                  {validationResult.auto_corrected.map((item, index) => (
                    <div key={index} className="text-sm bg-[var(--wj-warning-bg)] p-2 rounded">
                      <span className="text-[var(--wj-muted)]">행 {item.row_number}:</span> {item.message}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 신규 Part 항목들 */}
            {validationResult.new_parts.length > 0 && (
              <div>
                <h4 className="font-medium text-[var(--wj-accent-strong)] mb-2">신규 Part 항목</h4>
                <div className="max-h-32 overflow-y-auto space-y-1">
                  {validationResult.new_parts.map((item, index) => (
                    <div key={index} className="text-sm bg-[var(--wj-bg-strong)] p-2 rounded">
                      <span className="text-[var(--wj-muted)]">행 {item.row_number}:</span> {item.message}
                    </div>
                  ))}
                </div>
                <p className="text-sm text-[var(--wj-accent-strong)] mt-2">
                  ℹ️ 신규 Part 정보를 입력해주세요.
                </p>
              </div>
            )}

            {/* 오류 항목들 */}
            {validationResult.errors.length > 0 && (
              <div>
                <h4 className="font-medium text-[var(--wj-danger)] mb-2">오류 항목</h4>
                <div className="max-h-32 overflow-y-auto space-y-1">
                  {validationResult.errors.map((item, index) => (
                    <div key={index} className="text-sm bg-[var(--wj-danger-bg)] p-2 rounded">
                      <span className="text-[var(--wj-muted)]">행 {item.row_number}:</span>
                      {Array.isArray(item.errors) ? item.errors.join(', ') : item.errors}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 최종 업로드 버튼 */}
            {validationResult.errors.length === 0 && (
              <Button
                onClick={handleFinalImport}
                disabled={isUploading || (validationResult.new_parts.length > 0 && !showNewPartModal)}
                className="w-full bg-[var(--wj-success)] hover:bg-[var(--wj-success)]"
              >
                {isUploading ? '업로드 중...' : '최종 업로드'}
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {/* 신규 Part 정보 입력 모달 */}
      {showNewPartModal && newPartsInfo.length > 0 && (
        <div className="fixed inset-0 bg-[var(--wj-surface-solid)] bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-[var(--wj-surface-solid)] rounded-lg p-6 w-full max-w-md">
            <h3 className="text-lg font-medium mb-4">
              신규 Part 정보 입력 ({currentNewPartIndex + 1}/{newPartsInfo.length})
            </h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-[var(--wj-text)]">Part No.</label>
                <input
                  type="text"
                  value={newPartsInfo[currentNewPartIndex]?.part_no || ''}
                  disabled
                  className="mt-1 block w-full rounded border-[var(--wj-border)] bg-[var(--wj-bg-strong)]"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-[var(--wj-text)]">모델 코드 *</label>
                <input
                  type="text"
                  value={newPartsInfo[currentNewPartIndex]?.model_code || ''}
                  onChange={(e) => updateNewPartInfo('model_code', e.target.value)}
                  className="mt-1 block w-full rounded border-[var(--wj-border)]"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-[var(--wj-text)]">설명</label>
                <input
                  type="text"
                  value={newPartsInfo[currentNewPartIndex]?.description || ''}
                  onChange={(e) => updateNewPartInfo('description', e.target.value)}
                  className="mt-1 block w-full rounded border-[var(--wj-border)]"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-[var(--wj-text)]">가공 타입</label>
                <input
                  type="text"
                  value={newPartsInfo[currentNewPartIndex]?.process_type || ''}
                  onChange={(e) => updateNewPartInfo('process_type', e.target.value)}
                  className="mt-1 block w-full rounded border-[var(--wj-border)]"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-[var(--wj-text)]">소재 종류</label>
                <input
                  type="text"
                  value={newPartsInfo[currentNewPartIndex]?.material_type || ''}
                  onChange={(e) => updateNewPartInfo('material_type', e.target.value)}
                  className="mt-1 block w-full rounded border-[var(--wj-border)]"
                />
              </div>
            </div>
            <div className="flex gap-2 mt-6">
              <Button
                onClick={() => setShowNewPartModal(false)}
                variant="secondary"
                className="flex-1"
              >
                취소
              </Button>
              <Button
                onClick={handleNewPartSubmit}
                className="flex-1"
                disabled={!newPartsInfo[currentNewPartIndex]?.model_code}
              >
                {currentNewPartIndex < newPartsInfo.length - 1 ? '다음' : '완료'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}