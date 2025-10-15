import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Plus, Save } from 'lucide-react';
import api from '@/lib/api';
import { toast } from 'react-toastify';
import type { PartSpec } from '@/hooks/usePartSpecs';
import { useLang } from '@/i18n';
import DuplicateSetupModal from './DuplicateSetupModal';
import NewPartSpecModal from './NewPartSpecModal';
import { useQueryClient } from '@tanstack/react-query';
import SetupRowComponent from './SetupRowComponent';

interface SetupRow {
  id: string;
  machine_no: number | null;
  model_code: string;
  part_no: string;
  target_cycle_time: number | null;
  standard_cycle_time: number | null;
  avg_cycle_time: number | null;
  personnel_count?: number | null;
}

interface CycleTimeTableFormProps {
  onSuccess: () => void;
}

const generateId = () => Math.random().toString(36).substr(2, 9);

const formatModelWithDescription = (spec: Pick<PartSpec, 'model_code' | 'description'> | null) => {
  if (!spec || !spec.model_code) return '';
  return spec.description ? `${spec.model_code} - ${spec.description}` : spec.model_code;
};

export default function CycleTimeTableForm({ onSuccess }: CycleTimeTableFormProps) {
  const { t } = useLang();
  const queryClient = useQueryClient();
  const [setupDate, setSetupDate] = useState(new Date().toISOString().split('T')[0]);
  const [rows, setRows] = useState<SetupRow[]>([
    { id: generateId(), machine_no: null, model_code: '', part_no: '', target_cycle_time: null, standard_cycle_time: null, avg_cycle_time: null, personnel_count: null }
  ]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [showAddPartModal, setShowAddPartModal] = useState(false);
  const [newPartInitialValue, setNewPartInitialValue] = useState('');
  const [initialModelCode, setInitialModelCode] = useState('');
  const [activeRowId, setActiveRowId] = useState<string | null>(null);

  const [duplicateModalOpen, setDuplicateModalOpen] = useState(false);
  const [pendingSubmission, setPendingSubmission] = useState<any>(null);



  const addRow = () => {
    setRows(prev => [...prev, { id: generateId(), machine_no: null, model_code: '', part_no: '', target_cycle_time: null, standard_cycle_time: null, avg_cycle_time: null, personnel_count: null }]);
  };

  const removeRow = (id: string) => {
    if (rows.length <= 1) {
      toast.error(t('ct_table.min_row_error'));
      return;
    }
    setRows(prev => prev.filter(row => row.id !== id));
  };

  const updateRow = (id: string, field: keyof SetupRow, value: any) => {
    setRows(prev => prev.map(row => (row.id === id ? { ...row, [field]: value } : row)));
  };

  const handleMachineChange = async (rowId: string, machineNo: number) => {
    updateRow(rowId, 'machine_no', machineNo);
  };

  const handlePartChange = async (rowId: string, partSpec: PartSpec | null) => {
    if (!partSpec) {
      updateRow(rowId, 'part_no', '');
      updateRow(rowId, 'standard_cycle_time', null);
      updateRow(rowId, 'avg_cycle_time', null);
      updateRow(rowId, 'model_code', '');
      return;
    }
    updateRow(rowId, 'part_no', partSpec.part_no);
    updateRow(rowId, 'model_code', formatModelWithDescription(partSpec));
    const standardTime = await fetchStandardCycleTime(partSpec.part_no);
    updateRow(rowId, 'standard_cycle_time', standardTime);
    const avgTime = await fetchAvgCycleTime(partSpec.part_no);
    updateRow(rowId, 'avg_cycle_time', avgTime);
  };

  const handleModelChange = (rowId: string, model: PartSpec | null, keepPartNo = false) => {
    // 전체 텍스트 저장: model_code + description
    const fullModelText = formatModelWithDescription(model);
    updateRow(rowId, 'model_code', fullModelText);
    if (!keepPartNo) {
      updateRow(rowId, 'part_no', '');
      updateRow(rowId, 'standard_cycle_time', null);
      updateRow(rowId, 'avg_cycle_time', null);
    }
  };

  const handleAddNewPart = (rowId: string, initialValue: string) => {
    setNewPartInitialValue(initialValue);
    setInitialModelCode('');
    setActiveRowId(rowId);
    setShowAddPartModal(true);
  };

  const handleAddNewModel = (rowId: string, modelCode: string) => {
    // 새 모델 추가를 위한 Part No를 임시로 생성
    const tempPartNo = `${modelCode}_NEW_${Date.now()}`;
    setNewPartInitialValue(tempPartNo);
    setInitialModelCode(modelCode);
    setActiveRowId(rowId);
    setShowAddPartModal(true);
  };

  const handleNewPartCreated = (newPart: PartSpec) => {
    if (activeRowId) {
      queryClient.invalidateQueries({ queryKey: ['parts-all'] }).then(() => {
        handlePartChange(activeRowId, newPart);
      });
    }
    setShowAddPartModal(false);
    setActiveRowId(null);
  };

  const fetchStandardCycleTime = async (partNo: string) => {
    if (!partNo) return null;
    try {
      const response = await api.get(`/parts/${partNo}/standard-cycle-time/`);
      return response.data.standard_cycle_time;
    } catch (error) { return null; }
  };

  const fetchAvgCycleTime = async (partNo: string) => {
    if (!partNo) return null;
    try {
      const response = await api.get('/injection/reports/avg-cycle-time/', { params: { part_no: partNo } });
      return response.data.avg_cycle_time;
    } catch (error: any) { return null; }
  };

  const handleSubmit = async (duplicateAction?: 'new_version' | 'update_existing') => {
    // 개별 모달과 동일한 검증 로직 적용
    const validRows = rows.filter(r =>
      r.machine_no &&
      r.part_no &&
      r.model_code &&
      r.target_cycle_time &&
      r.target_cycle_time > 0
    );

    if (validRows.length === 0) {
      toast.error(t('ct_table.valid_row_error'));
      return;
    }

    setIsSubmitting(true);
    try {
      const payload = {
        setup_date: setupDate,
        setups: validRows.map(r => ({
          machine_no: r.machine_no,
          part_no: r.part_no,
          model_code: r.model_code,
          target_cycle_time: r.target_cycle_time ? Math.round(r.target_cycle_time) : null,
          personnel_count: r.personnel_count ? parseFloat(String(r.personnel_count)) : null,
          mean_cycle_time: r.avg_cycle_time ? Math.round(Number(r.avg_cycle_time)) : null,
          standard_cycle_time: r.standard_cycle_time ? Math.round(r.standard_cycle_time) : null
        })),
        ...(duplicateAction && { duplicate_action: duplicateAction })
      };
      const response = await api.post('/injection/setup/bulk-create/', payload);
      const { created_count = 0, updated_count = 0 } = response.data;
      if (created_count > 0) toast.success(t('ct_table.create_success', { count: created_count }));
      if (updated_count > 0) toast.success(`${updated_count}개 설정이 수정되었습니다.`);
      setRows([{ id: generateId(), machine_no: null, model_code: '', part_no: '', target_cycle_time: null, standard_cycle_time: null, avg_cycle_time: null, personnel_count: null }]);
      onSuccess();
    } catch (error: any) {
      if (error.response?.status === 409) {
        setPendingSubmission({ ...error.response.data, setup_date: setupDate, setups: validRows });
        setDuplicateModalOpen(true);
      } else {
        toast.error(error.response?.data?.detail || t('ct_table.create_fail'));
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Card className="p-6">
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-gray-900 mb-2">{t('ct_table.title_ct_personnel')}</h2>
        <p className="text-gray-600">{t('ct_table.description')}</p>
      </div>
      <div className="mb-6">
        <Label htmlFor="setup_date">{t('ct_table.setup_date_label')}</Label>
        <Input id="setup_date" type="date" value={setupDate} onChange={(e) => setSetupDate(e.target.value)} className="w-48" />
      </div>
      <div className="overflow-x-auto mb-2 text-sm">
        <table className="w-full border-collapse border border-gray-300">
          <thead>
            <tr className="bg-gray-50">
              <th className="border border-gray-300 px-3 py-2 text-center w-40">{t('ct_table.machine_header')}</th>
              <th className="border border-gray-300 px-3 py-2 text-center w-64">{t('ct_table.model_header')}</th>
              <th className="border border-gray-300 px-3 py-2 text-center w-64">{t('ct_table.part_no_header')}</th>
              <th className="border border-gray-300 px-3 py-2 text-center w-[8.5rem]">{t('ct_table.target_ct_header')}</th>
              <th className="border border-gray-300 px-3 py-2 text-center w-[8.5rem]">{t('ct_table.standard_ct_header')}</th>
              <th className="border border-gray-300 px-3 py-2 text-center w-[8.5rem]">{t('ct_table.avg_ct_header')}</th>
              <th className="border border-gray-300 px-3 py-2 text-center w-[8.5rem]">{t('ct_table.personnel_header')}</th>
              <th className="border border-gray-300 px-3 py-2 text-center w-12">{t('ct_table.action_header')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <SetupRowComponent
                key={row.id}
                row={row}
                onRowChange={updateRow}
                onRowRemove={removeRow}
                onMachineChange={handleMachineChange}
                onPartChange={handlePartChange}
                onModelChange={handleModelChange}
                onAddNewPart={handleAddNewPart}
                onAddNewModel={handleAddNewModel}
              />
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex justify-between items-center">
        <Button type="button" variant="secondary" onClick={addRow} className="flex items-center gap-2">
          <Plus className="w-4 h-4" />
          {t('ct_table.add_row_button')}
        </Button>
        <div className="flex gap-3">
          <Button type="button" variant="secondary" onClick={() => setRows([{ id: generateId(), machine_no: null, model_code: '', part_no: '', target_cycle_time: null, standard_cycle_time: null, avg_cycle_time: null, personnel_count: null }])}>
            {t('ct_table.reset_button')}
          </Button>
          <Button onClick={() => handleSubmit()} disabled={isSubmitting} className="flex items-center gap-2">
            <Save className="w-4 h-4" />
            {isSubmitting ? t('ct_table.saving_button') : t('ct_table.save_all_button')}
          </Button>
        </div>
      </div>

      <NewPartSpecModal
        isOpen={showAddPartModal}
        onClose={() => setShowAddPartModal(false)}
        onSuccess={handleNewPartCreated}
        initialPartNo={newPartInitialValue}
        initialModelCode={initialModelCode}
      />

      {pendingSubmission && (
        <DuplicateSetupModal
          isOpen={duplicateModalOpen}
          onClose={() => setPendingSubmission(null)}
          duplicateItems={pendingSubmission.duplicates}
          onCreateNewVersion={() => handleSubmit('new_version')}
          onUpdateExisting={() => handleSubmit('update_existing')}
        />
      )}
    </Card>
  );
}