import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { useLang } from '@/i18n';
import api from '@/lib/api';
import { toast } from 'react-toastify';
import machines from '@/constants/machines';
import MachineSelector from './MachineSelector';
import NewModelSelector from './NewModelSelector';
import NewPartNoSelector from './NewPartNoSelector';
import type { PartSpec } from '@/hooks/usePartSpecs';
import NewPartSpecModal from './NewPartSpecModal';
import { useQueryClient } from '@tanstack/react-query';

interface MachineSetupModalProps {
  isOpen: boolean;
  onClose: () => void;
  machineId: number;
  setup: any; // Can be undefined for new setups
  onSuccess?: () => void;
}

export default function MachineSetupModal({
  isOpen,
  onClose,
  machineId,
  setup,
  onSuccess
}: MachineSetupModalProps) {
  const { t } = useLang();
  const queryClient = useQueryClient();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [editMode, setEditMode] = useState(false);

  const isEditMode = !!setup;

  const [formData, setFormData] = useState({
    machine_no: 0,
    model_code: '',
    part_no: '',
    target_cycle_time: '',
    standard_cycle_time: '',
    avg_cycle_time: '',
    personnel_count: ''
  });

  // PartSpecSelector용 상태
  const [selectedModel, setSelectedModel] = useState<PartSpec | null>(null);
  const [selectedPart, setSelectedPart] = useState<PartSpec | null>(null);
  const [showAddPartModal, setShowAddPartModal] = useState(false);
  const [newPartInitialValue, setNewPartInitialValue] = useState('');
  const [newPartInitialModel, setNewPartInitialModel] = useState('');

  const machine = machines.find(m => m.id === machineId);

  useEffect(() => {
    if (isOpen) {
      if (isEditMode) {
        setFormData({
          machine_no: machineId,
          model_code: setup.model_code || '',
          part_no: setup.part_no || '',
          target_cycle_time: setup.target_cycle_time?.toString() || '',
          standard_cycle_time: setup.standard_cycle_time?.toString() || '',
          avg_cycle_time: setup.mean_cycle_time?.toString() || '',
          personnel_count: setup.personnel_count?.toString() || ''
        });
        if (setup.model_code) {
          const [model_code, ...rest] = setup.model_code.split(' - ');
          const description = rest.join(' - ');
          const model = { model_code, description, part_no: setup.part_no || '' } as PartSpec;
          setSelectedModel(model);
          setSelectedPart({ part_no: setup.part_no, model_code, description } as PartSpec);
        }
        setEditMode(false);
      } else {
        setFormData({
          machine_no: machineId,
          model_code: '',
          part_no: '',
          target_cycle_time: '',
          standard_cycle_time: '',
          avg_cycle_time: '',
          personnel_count: ''
        });
        setSelectedModel(null);
        setSelectedPart(null);
        setEditMode(true);
      }
      setError('');
    }
  }, [setup, isOpen, machineId, isEditMode]);

  const handleCreate = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setError('');
    setLoading(true);

    try {
        const createData = {
            machine_no: formData.machine_no,
            part_no: formData.part_no,
            model_code: formData.model_code,
            target_cycle_time: formData.target_cycle_time ? Math.round(parseFloat(formData.target_cycle_time)) : null,
            mean_cycle_time: formData.avg_cycle_time ? Math.round(parseFloat(formData.avg_cycle_time)) : null,
            personnel_count: formData.personnel_count ? parseFloat(formData.personnel_count) : null,
        };
        await api.post('/injection/setup/', createData);
        toast.success(t('setup.create_success'));
        onClose();
        if (onSuccess) onSuccess();
    } catch (error: any) {
        const data = error?.response?.data;
        let msg = t('save_fail');
        if (data && typeof data === 'object') {
            msg = data.detail || Object.values(data).flat().join(' ');
        } else if (error?.message) {
            msg = error.message;
        }
        setError(String(msg));
    } finally {
        setLoading(false);
    }
  };

  const handleUpdate = async () => {
    setError('');
    setLoading(true);

    try {
      const updateData: any = {
        part_no: formData.part_no,
        model_code: formData.model_code,
        target_cycle_time: formData.target_cycle_time ? Math.round(parseFloat(formData.target_cycle_time)) : null,
        personnel_count: formData.personnel_count ? parseFloat(formData.personnel_count) : null,
      };
      if (formData.standard_cycle_time) {
        updateData.standard_cycle_time = Math.round(parseFloat(formData.standard_cycle_time));
      }
      if (formData.avg_cycle_time) {
        updateData.mean_cycle_time = Math.round(parseFloat(formData.avg_cycle_time));
      }
      Object.keys(updateData).forEach(key => {
        if (updateData[key] === null || updateData[key] === '') {
          delete updateData[key];
        }
      });

      await api.patch(`/injection/setup/${setup.id}/`, updateData);
      toast.success(t('setup.update_success'));
      onClose();
      if (onSuccess) onSuccess();
    } catch (error: any) {
      const data = error?.response?.data;
      let msg = t('save_fail');
      if (data && typeof data === 'object') {
        msg = data.detail || Object.values(data).flat().join(' ');
      } else if (error?.message) {
        msg = error.message;
      }
      setError(String(msg));
    } finally {
      setLoading(false);
    }
  };

  const handleCreateNewVersion = async () => {
    // This logic might need to be adjusted for create mode
    if (!isEditMode) return;

    setError('');
    setLoading(true);
    try {
      const today = new Date().toISOString().split('T')[0];
      const payload = {
        setup_date: today,
        setups: [{
          machine_no: machineId,
          part_no: formData.part_no,
          model_code: formData.model_code,
          target_cycle_time: formData.target_cycle_time ? Math.round(parseFloat(formData.target_cycle_time)) : null,
          mean_cycle_time: formData.avg_cycle_time ? Math.round(parseFloat(formData.avg_cycle_time)) : null,
          personnel_count: formData.personnel_count ? parseFloat(formData.personnel_count) : null,
        }],
        duplicate_action: 'new_version'
      };
      await api.post('/injection/setup/bulk-create/', payload);
      toast.success(t('setup.new_version_success'));
      onClose();
      if (onSuccess) onSuccess();
    } catch (error: any) {
      const data = error?.response?.data;
      let msg = t('setup.new_version_fail');
      if (data && typeof data === 'object') {
        msg = data.detail || data.errors?.join(', ') || Object.values(data).flat().join(' ');
      } else if (error?.message) {
        msg = error.message;
      }
      setError(String(msg));
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!isEditMode) return;
    if (window.confirm(t('delete_confirm'))) {
      setLoading(true);
      try {
        await api.delete(`/injection/setup/${setup.id}/`);
        toast.success(t('delete_success'));
        onClose();
        if (onSuccess) onSuccess();
      } catch (error) {
        toast.error(t('delete_fail'));
      } finally {
        setLoading(false);
      }
    }
  };

  const handleInputChange = (field: string, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const handleMachineChange = (machineId: number) => {
    setFormData(prev => ({ ...prev, machine_no: machineId }));
  };

  const formatModelWithDescription = (item: PartSpec | null) => {
    if (!item || !item.model_code) return '';
    return item.description ? `${item.model_code} - ${item.description}` : item.model_code;
  };

  const handleModelChange = (model: PartSpec | null) => {
    setSelectedModel(model);
    setSelectedPart(null);
    const fullModelText = formatModelWithDescription(model);
    setFormData(prev => ({
      ...prev,
      model_code: fullModelText,
      part_no: ''
    }));
  };

  const handlePartChange = async (part: PartSpec | null) => {
    setSelectedPart(part);
    if (!part) {
      setFormData(prev => ({
        ...prev,
        part_no: '',
        standard_cycle_time: '',
        avg_cycle_time: ''
      }));
      return;
    }

    setFormData(prev => ({ ...prev, part_no: part.part_no }));

    const fullModelText = formatModelWithDescription(part);
    if (fullModelText) {
      const model = { model_code: part.model_code, description: part.description, part_no: part.part_no } as PartSpec;
      setSelectedModel(model);
      setFormData(prev => ({
        ...prev,
        model_code: fullModelText
      }));
    }

    // Fetch standard and avg cycle times
    try {
      const [standardResponse, avgResponse] = await Promise.allSettled([
        api.get(`/parts/${part.part_no}/standard-cycle-time/`),
        api.get('/injection/reports/avg-cycle-time/', { params: { part_no: part.part_no } })
      ]);

      const standardTime = standardResponse.status === 'fulfilled' ?
        standardResponse.value.data.standard_cycle_time : null;
      const avgTime = avgResponse.status === 'fulfilled' ?
        avgResponse.value.data.avg_cycle_time : null;

      setFormData(prev => ({
        ...prev,
        standard_cycle_time: standardTime?.toString() || '',
        avg_cycle_time: avgTime?.toString() || ''
      }));
    } catch (error) {
      // Ignore errors for cycle time fetching
    }
  };

  const handleAddNewPart = (partNo: string) => {
    const normalizedPartNo = (partNo || '').toUpperCase();
    setNewPartInitialValue(normalizedPartNo);
    setNewPartInitialModel(selectedModel?.model_code || '');
    setShowAddPartModal(true);
  };

  const handleAddNewModel = (modelCode: string) => {
    const normalizedModel = (modelCode || '').toUpperCase();
    setNewPartInitialValue('');
    setNewPartInitialModel(normalizedModel);
    setShowAddPartModal(true);
  };

  const handleCloseAddPartModal = () => {
    setShowAddPartModal(false);
    setNewPartInitialValue('');
    setNewPartInitialModel('');
  };

  const handleNewPartCreated = (newPart: PartSpec) => {
    queryClient.invalidateQueries({ queryKey: ['parts-all'] }).then(() => {
      handlePartChange(newPart);
    });
    handleCloseAddPartModal();
  };

  // const handleModelAutoFill = (autoFillModel: PartSpec) => {
  //   // Part No. 입력으로 Model 자동 채우기 (RecordForm 로직 참조)
  //   setSelectedModel(autoFillModel);
  //   const fullModelText = autoFillModel.description ?
  //     `${autoFillModel.model_code} – ${autoFillModel.description}` :
  //     autoFillModel.model_code;
  //   setFormData(prev => ({
  //     ...prev,
  //     model_code: fullModelText
  //   }));
  // };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-6">
          <h3 className="text-xl font-semibold text-gray-900">
            {isEditMode ? t('setup.edit_machine_setup') : t('setup.new_setup_title')} - {machineId}{t('dashboard.machine_id_unit')} ({machine?.ton}T)
          </h3>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600 text-2xl font-bold">×</button>
        </div>

        <form onSubmit={isEditMode ? (e) => { e.preventDefault(); setEditMode(true); } : handleCreate} className="space-y-6">
          {/* Form fields */}
          <div className="grid grid-cols-1 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">{t('machine')} *</label>
              <MachineSelector
                selectedMachine={formData.machine_no}
                onMachineChange={handleMachineChange}
                disabled={isEditMode && !editMode}
                placeholder={t('select_machine')}
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">{t('setup.model_code')} *</label>
                <NewModelSelector
                  value={selectedModel}
                  onChange={handleModelChange}
                  onAddNewModel={handleAddNewModel}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">{t('part_no')} *</label>
                <NewPartNoSelector
                  model={selectedModel}
                  value={selectedPart}
                  onChange={handlePartChange}
                  onAddNewPart={handleAddNewPart}
                />
              </div>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">{t('target_cycle_time')} *</label>
              <input type="number" min="1" value={formData.target_cycle_time || ''} onChange={(e) => handleInputChange('target_cycle_time', e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-md" required disabled={isEditMode && !editMode} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">{t('standard_cycle_time')}</label>
              <input type="number" min="1" value={formData.standard_cycle_time || ''} onChange={(e) => handleInputChange('standard_cycle_time', e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-md" disabled={isEditMode && !editMode} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">{t('avg_cycle_time')}</label>
              <input type="number" min="1" value={formData.avg_cycle_time || ''} className="w-full px-3 py-2 border border-gray-300 rounded-md bg-gray-100" readOnly />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">{t('ct_table.personnel_header')}</label>
              <input type="number" min="0" step="0.1" value={formData.personnel_count || ''} onChange={(e) => handleInputChange('personnel_count', e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-md" disabled={isEditMode && !editMode} />
            </div>
          </div>

          {error && (
            <div className="p-3 bg-red-100 border border-red-400 rounded">
              <p className="text-sm text-red-800">{error}</p>
            </div>
          )}

          {/* Buttons */}
          <div className="pt-4">
            {!isEditMode ? (
                <div className="flex justify-end gap-3">
                    <Button type="button" variant="secondary" onClick={onClose} disabled={loading}>{t('cancel')}</Button>
                    <Button type="submit" variant="primary" disabled={loading}>{loading ? t('saving') : t('save')}</Button>
                </div>
            ) : !editMode ? (
              <div className="flex justify-end gap-3">
                <Button type="button" variant="danger" onClick={handleDelete} disabled={loading}>{t('delete')}</Button>
                <Button type="button" variant="primary" onClick={() => setEditMode(true)} disabled={loading}>{t('edit')}</Button>
                <Button type="button" variant="secondary" onClick={onClose} disabled={loading}>{t('cancel')}</Button>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="bg-gray-50 p-4 rounded-lg border flex flex-col">
                        <h4 className="font-semibold mb-2">{t('setup.edit_existing')}</h4>
                        <p className="text-xs text-gray-600 mb-3 flex-grow">{t('setup.edit_existing_desc')}</p>
                        <Button variant="primary" onClick={handleUpdate} disabled={loading} className="w-full">
                          {loading ? t('setup.updating') : t('setup.save_changes')}
                        </Button>
                    </div>
                    <div className="bg-blue-50 p-4 rounded-lg border border-blue-200 flex flex-col">
                        <h4 className="font-semibold text-blue-800 mb-2">{t('setup.create_new_version')}</h4>
                        <p className="text-xs text-blue-700 mb-3 flex-grow">{t('setup.create_new_version_desc')}</p>
                        <Button variant="info" onClick={handleCreateNewVersion} disabled={loading} className="w-full">
                          {loading ? t('setup.creating') : t('setup.create_new_version')}
                        </Button>
                    </div>
                </div>
                <div className="flex justify-center">
                    <Button type="button" variant="secondary" onClick={() => setEditMode(false)} disabled={loading}>{t('back')}</Button>
                </div>
              </div>
            )}
          </div>
        </form>
      </div>

      {/* New Part Modal */}
      <NewPartSpecModal
        isOpen={showAddPartModal}
        onClose={handleCloseAddPartModal}
        onSuccess={handleNewPartCreated}
        initialPartNo={newPartInitialValue}
        initialModelCode={newPartInitialModel}
      />
    </div>
  );
}