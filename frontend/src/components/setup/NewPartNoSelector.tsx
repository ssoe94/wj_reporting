
import { useState, useMemo } from 'react';
import { Autocomplete, TextField } from '@mui/material';
import { Plus } from 'lucide-react';
import { usePartSpecSearch, usePartListByModel } from '@/hooks/usePartSpecs';
import { useAssemblyPartsByModel, useAssemblyPartspecsByModel, useAssemblyPartNoSearch } from '@/hooks/useAssemblyParts';
import type { PartSpec } from '@/hooks/usePartSpecs';
import { useLang } from '@/i18n';

interface NewPartNoSelectorProps {
  model: PartSpec | null;
  value: PartSpec | null;
  onChange: (part: PartSpec | null) => void;
  onAddNewPart: (partNo: string) => void;
}

export default function NewPartNoSelector({ model, value, onChange, onAddNewPart }: NewPartNoSelectorProps) {
  const { t } = useLang();
  const [query, setQuery] = useState('');

  const { data: searchResults = [] } = usePartSpecSearch(query.toUpperCase());
  const { data: modelParts = [] } = usePartListByModel(model?.model_code);
  const { data: asmPartsByModel = [] } = useAssemblyPartsByModel(model?.model_code);
  const { data: asmPartspecsByModel = [] } = useAssemblyPartspecsByModel(model?.model_code);
  const { data: asmPartNoSearch = [] } = useAssemblyPartNoSearch(query || '');

  const options = useMemo(() => {
    const baseOptions = model
      ? (
          (asmPartspecsByModel as any).length
            ? (asmPartspecsByModel as any)
            : ((asmPartsByModel as any).length
                ? (asmPartsByModel as any)
                : modelParts)
        )
      : (() => {
          const asmOptions = Array.isArray(asmPartNoSearch)
            ? (asmPartNoSearch as any[]).map((r:any)=> ({ part_no: r.part_no, model_code: r.model, description: r.description || '' }))
            : [];
          const merged = [...asmOptions, ...searchResults];
          const seen = new Set<string>();
          return merged.filter((o:any)=>{
            const key = String(o.part_no||'');
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
        })();
    return baseOptions;
  }, [model, asmPartspecsByModel, asmPartsByModel, modelParts, asmPartNoSearch, searchResults]);

  return (
    <Autocomplete<PartSpec | { isAddNew: boolean; part_no: string }>
      options={options}
      getOptionLabel={(opt) => {
        if ('isAddNew' in opt) return `"${opt.part_no}" ${t('add_new_part_prompt')}`;
        return String((opt as PartSpec).part_no || '');
      }}
      onInputChange={(_, v) => setQuery(v)}
      filterOptions={(opts, state) => {
        const input = (state.inputValue || '').trim().toUpperCase();
        let filtered = opts.filter((o: any) => ('isAddNew' in o) ? true : String(o.part_no || '').toUpperCase().includes(input));
        
        if (input && !filtered.some(o => ('part_no' in o && o.part_no.toUpperCase() === input))) {
          filtered.push({ isAddNew: true, part_no: input });
        }
        return filtered;
      }}
      renderOption={(props, option) => {
        const { key, ...rest } = props as any;
        if ('isAddNew' in option) {
          return (
            <li key={key} {...rest} className="bg-green-50 hover:bg-green-100 border-t border-green-200">
              <div className="flex items-center justify-center gap-2 text-green-700 font-medium py-2 text-sm">
                <Plus className="h-3 w-3" />
                <span>{`"${option.part_no}" ${t('add_new_part_prompt')}`}</span>
              </div>
            </li>
          );
        }
        const spec = option as PartSpec;
        return (
          <li key={key} {...rest}>
            <div className="flex flex-col">
              <span className="font-mono font-medium">{spec.part_no}</span>
              {spec.model_code && (
                <span className="text-sm text-gray-600">
                  {spec.model_code}
                  {spec.description ? ` - ${spec.description}` : ''}
                </span>
              )}
            </div>
          </li>
        );
      }}
      onChange={(_, v) => {
        if (v && 'isAddNew' in v) {
          onAddNewPart(v.part_no);
          return;
        }
        onChange(v as PartSpec | null);
      }}
      value={value}
      renderInput={(params) => <TextField {...params} size="small" placeholder={`Part No. ${t('input_or_select')}`} required />}
    />
  );
}
