import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import type { PartSpec } from '@/hooks/usePartSpecs';
import { useLang } from '@/i18n';
import { Trash2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import MachineSelector from './MachineSelector';
import NewModelSelector from './NewModelSelector';
import NewPartNoSelector from './NewPartNoSelector';

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

interface SetupRowProps {
  row: SetupRow;
  onRowChange: (id: string, field: keyof SetupRow, value: any) => void;
  onRowRemove: (id: string) => void;
  onMachineChange: (id: string, machineNo: number) => void;
  onPartChange: (id: string, partSpec: PartSpec | null) => void;
  onModelChange: (id: string, model: PartSpec | null, keepPartNo?: boolean) => void;
  onAddNewPart: (rowId: string, initialValue: string) => void;
  onAddNewModel: (rowId: string, modelCode: string) => void;
}

export default function SetupRowComponent({
  row,
  onRowChange,
  onRowRemove,
  onMachineChange,
  onPartChange,
  onModelChange,
  onAddNewPart,
  onAddNewModel,
}: SetupRowProps) {
  const { t } = useLang();
  const [model, setModel] = useState<PartSpec | null>(null);
  const [part, setPart] = useState<PartSpec | null>(null);

  // Initialize state from row props
  useEffect(() => {
    if (row.model_code && !model) {
      const parts = row.model_code.split(' – ');
      const model_code = parts[0];
      const description = parts[1] || '';
      const newModel = { model_code, description, part_no: '' } as PartSpec;
      setModel(newModel);
    }
    if (row.part_no && !part) {
        const newPart = { ...model, part_no: row.part_no } as PartSpec;
        setPart(newPart);
    }
  }, [row.model_code, row.part_no]);

  const handleMachineChange = (machineId: number) => {
    onMachineChange(row.id, machineId);
  };

  const handleModelChange = (selectedModel: PartSpec | null) => {
    setModel(selectedModel);
    setPart(null); // Reset part when model changes
    onModelChange(row.id, selectedModel);
  };

  const handlePartChange = (selectedPart: PartSpec | null) => {
    setPart(selectedPart);
    onPartChange(row.id, selectedPart);
    // Auto-fill model if part selection provides a more complete model
    if (selectedPart && selectedPart.model_code && (!model || model.model_code !== selectedPart.model_code)) {
        const newModel = { ...selectedPart };
        setModel(newModel);
        onModelChange(row.id, newModel, true);
    }
  };

  return (
    <tr>
      <td className="border border-gray-300 px-3 py-2">
        <MachineSelector
          selectedMachine={row.machine_no}
          onMachineChange={handleMachineChange}
          className="w-40 px-2 py-1 border border-gray-300 rounded text-sm"
        />
      </td>
      <td className="border border-gray-300 px-3 py-2 text-sm">
        <NewModelSelector
          value={model}
          onChange={handleModelChange}
          onAddNewModel={(modelCode) => onAddNewModel(row.id, modelCode)}
        />
      </td>
      <td className="border border-gray-300 px-3 py-2 text-sm">
        <NewPartNoSelector
          model={model}
          value={part}
          onChange={handlePartChange}
          onAddNewPart={(partNo) => onAddNewPart(row.id, partNo)}
        />
      </td>
      <td className="border border-gray-300 px-2 py-2">
        <Input type="number" min="1" value={row.target_cycle_time || ''} onChange={(e) => onRowChange(row.id, 'target_cycle_time', parseInt(e.target.value) || null)} placeholder={t('ct_table.target_ct_placeholder')} className="w-[8.5rem] text-center" />
      </td>
      <td className="border border-gray-300 px-2 py-2">
        <Input type="number" min="1" value={row.standard_cycle_time || ''} onChange={(e) => onRowChange(row.id, 'standard_cycle_time', parseInt(e.target.value) || null)} placeholder={t('ct_table.standard_ct_placeholder')} className="w-[8.5rem] text-center" />
      </td>
      <td className="border border-gray-300 px-2 py-2">
        <Input type="text" value={row.avg_cycle_time ?? ''} readOnly placeholder={t('ct_table.avg_ct_placeholder')} className="w-[8.5rem] text-center bg-gray-100" />
      </td>
      <td className="border border-gray-300 px-2 py-2">
        <Input
          type="number"
          min="0"
          step="0.1"
          value={row.personnel_count || ''}
          onChange={(e) => onRowChange(row.id, 'personnel_count', parseFloat(e.target.value) || 0)}
          placeholder={t('ct_table.personnel_header')}
          className="w-[8.5rem] text-center"
          required
        />
      </td>
      <td className="border border-gray-300 px-3 py-2 text-center">
        <Button type="button" variant="ghost" size="sm" onClick={() => onRowRemove(row.id)} className="text-red-600 hover:text-red-800">
          <Trash2 className="w-4 h-4" />
        </Button>
      </td>
    </tr>
  );
}
