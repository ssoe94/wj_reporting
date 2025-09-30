import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import type { PartSpec } from '@/hooks/usePartSpecs';
import { useLang } from '@/i18n';
import { Trash2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import MachineSelector from './MachineSelector';
import NewModelSelector from './NewModelSelector';
import NewPartNoSelector from './NewPartNoSelector';

const parseModelWithDescription = (value: string, partNo?: string): PartSpec | null => {
  if (!value) return null;
  const normalized = value.replace(/[\s\u00A0]*[–—−][\s\u00A0]*/g, ' - ');
  const [model_codeRaw, ...rest] = normalized.split(' - ');
  const model_code = (model_codeRaw || '').trim();
  const description = rest.join(' - ').trim();
  if (!model_code) return null;
  return {
    model_code,
    description,
    part_no: partNo || ''
  } as PartSpec;
};

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
    setModel(parseModelWithDescription(row.model_code, row.part_no));
  }, [row.model_code, row.part_no]);

  useEffect(() => {
    if (row.part_no) {
      setPart({
        part_no: row.part_no,
        model_code: model?.model_code || '',
        description: model?.description || ''
      } as PartSpec);
    } else {
      setPart(null);
    }
  }, [row.part_no, model?.model_code, model?.description]);

  const handleMachineChange = (machineId: number) => {
    onMachineChange(row.id, machineId);
  };

  const handleModelChange = (selectedModel: PartSpec | null) => {
    setModel(selectedModel);
    setPart(null);
    onModelChange(row.id, selectedModel);
  };

  const handlePartChange = (selectedPart: PartSpec | null) => {
    setPart(selectedPart);
    onPartChange(row.id, selectedPart);
    if (selectedPart) {
      const combinedLabel = `${selectedPart.model_code}${selectedPart.description ? ` - ${selectedPart.description}` : ''}`;
      const newModel = parseModelWithDescription(combinedLabel, selectedPart.part_no);
      if (newModel && (!model || model.model_code !== newModel.model_code || model.description !== newModel.description)) {
        setModel(newModel);
        onModelChange(row.id, newModel, true);
      }
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
