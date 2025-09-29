import { useState, useMemo, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Autocomplete, TextField } from '@mui/material';
import { usePartSpecSearch, usePartListByModel } from '@/hooks/usePartSpecs';
import type { PartSpec } from '@/hooks/usePartSpecs';
import { useLang } from '@/i18n';
import { Plus } from 'lucide-react';

interface PartSpecSelectorProps {
  model: PartSpec | null;
  partNo: string;
  onModelChange: (model: PartSpec | null) => void;
  onPartChange: (part: PartSpec | null) => void;
  onAddNewPart: (partNo: string) => void;
  disabled?: boolean;
  modelClassName?: string;
  partClassName?: string;
}

export default function PartSpecSelector({
  model,
  partNo,
  onModelChange,
  onPartChange,
  onAddNewPart,
  disabled = false,
  modelClassName = 'w-full',
  partClassName = 'w-full'
}: PartSpecSelectorProps) {
  const { t } = useLang();
  const [modelSearch, setModelSearch] = useState('');

  const { data: modelResults = [], isLoading: isLoadingModels } = usePartSpecSearch(modelSearch);
  const { data: partsForModel = [], isLoading: isLoadingParts } = usePartListByModel(model?.model_code);

  const uniqueModelDesc = useMemo(() => {
    const map = new Map<string, PartSpec>();
    modelResults.forEach((it) => {
      const key = `${it.model_code}|${it.description}`;
      if (!map.has(key)) map.set(key, it);
    });
    return Array.from(map.values());
  }, [modelResults]);

  useEffect(() => {
    if (!model && partNo) {
      // partNo가 있는데 model이 없는 경우, 해당 partNo의 model을 찾아서 설정
      const matchingPart = partsForModel.find(p => p.part_no === partNo);
      if (matchingPart) {
        const matchingModel = modelResults.find(m => m.model_code === matchingPart.model_code);
        if (matchingModel) {
          onModelChange(matchingModel);
        }
      }
    }
  }, [model, partNo, partsForModel, modelResults, onModelChange]);

  return (
    <div className="space-y-4">
      {/* Model Selector */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Model *
        </label>
        <Autocomplete<PartSpec>
          className={modelClassName}
          options={uniqueModelDesc}
          loading={isLoadingModels}
          disabled={disabled}
          onInputChange={(_, val) => setModelSearch(val)}
          getOptionLabel={(opt) => `${opt.model_code} – ${opt.description}`}
          value={model}
          onChange={(_, v) => onModelChange(v)}
          renderInput={(params) => (
            <TextField
              {...params}
              size="small"
              placeholder={t('ct_table.model_search_placeholder')}
            />
          )}
        />
      </div>

      {/* Part Selector */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Part No. *
        </label>
        <Autocomplete<PartSpec | { isAddNew: boolean; part_no: string }>
          className={partClassName}
          options={partsForModel}
          loading={isLoadingParts}
          disabled={disabled || !model}
          getOptionLabel={(opt) =>
            (opt as any).isAddNew ? (opt as any).part_no : (opt as PartSpec).part_no
          }
          value={partNo ? partsForModel.find(p => p.part_no === partNo) : null}
          onChange={(_, v) => {
            if (v && (v as any).isAddNew) {
              onAddNewPart((v as any).part_no);
            } else {
              onPartChange(v as PartSpec | null);
            }
          }}
          filterOptions={(opts, state) => {
            const input = state.inputValue.trim().toUpperCase();
            if (!input) return opts;
            const filtered = opts.filter(o => o.part_no.toUpperCase().includes(input));
            if (filtered.length === 0 && input) {
              filtered.push({ isAddNew: true, part_no: input } as any);
            }
            return filtered;
          }}
          renderInput={(params) => (
            <TextField
              {...params}
              size="small"
              placeholder={t('ct_table.part_no_placeholder')}
            />
          )}
          renderOption={(props, option) => {
            if ((option as any).isAddNew) {
              return (
                <li {...props}>
                  <Button variant="ghost" size="sm" className="w-full justify-start">
                    <Plus className="w-4 h-4 mr-2" />
                    <span>"{(option as any).part_no}" {t('add_new_part_prompt')}</span>
                  </Button>
                </li>
              );
            }
            return (
              <li {...props}>
                <div className="flex flex-col w-full">
                  <span className="font-mono font-medium">{(option as PartSpec).part_no}</span>
                  <span className="text-sm text-gray-600">
                    {(option as PartSpec).model_code}
                    {(option as PartSpec).description ? ` - ${(option as PartSpec).description}` : ''}
                  </span>
                </div>
              </li>
            );
          }}
        />
      </div>
    </div>
  );
}