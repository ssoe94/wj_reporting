
import { useState, useMemo } from 'react';
import { Autocomplete, TextField } from '@mui/material';
import { Plus } from 'lucide-react';
import { usePartSpecSearch } from '@/hooks/usePartSpecs';
import type { PartSpec } from '@/hooks/usePartSpecs';
import { useLang } from '@/i18n';

interface NewModelSelectorProps {
  value: PartSpec | null;
  onChange: (model: PartSpec | null) => void;
  onAddNewModel: (modelCode: string) => void;
}

export default function NewModelSelector({ value, onChange, onAddNewModel }: NewModelSelectorProps) {
  const { t } = useLang();
  const [query, setQuery] = useState('');
  const { data: searchResults = [] } = usePartSpecSearch(query.toUpperCase());

  const uniqueModelDesc = useMemo(() => {
    const map = new Map<string, PartSpec>();
    searchResults.forEach((it) => {
      const key = `${it.model_code}|${it.description}`;
      if (!map.has(key)) map.set(key, it);
    });
    return Array.from(map.values());
  }, [searchResults]);

  return (
    <Autocomplete<PartSpec | { isAddNew: boolean; model_code: string }>
      options={uniqueModelDesc}
      getOptionLabel={(opt) => {
        if ('isAddNew' in opt) return `"${opt.model_code}" ${t('add_new_model_prompt')}`;
        const spec = opt as PartSpec;
        return spec.description ? `${spec.model_code} - ${spec.description}` : spec.model_code;
      }}
      isOptionEqualToValue={(option, value) => 
        option.model_code === value.model_code &&
        option.description === value.description
      }
      onInputChange={(_, v) => setQuery(v)}
      filterOptions={(opts, state) => {
        const input = (state.inputValue || '').trim();
        let filtered = opts.slice();
        if (input) {
          const exists = filtered.some(o => `${o.model_code} - ${(o as any).description || ''}`.toUpperCase().includes(input.toUpperCase()));
          if (!exists) {
            filtered.push({ isAddNew: true, model_code: input });
          }
        }
        return filtered;
      }}
      renderOption={(props, option) => {
        const { key, ...rest } = props as any;
        if ('isAddNew' in option) {
          return (
            <li key={key} {...rest} className="bg-blue-50 hover:bg-blue-100 border-t border-blue-200">
              <div className="flex items-center justify-center gap-2 text-blue-700 font-medium py-2 text-sm">
                <Plus className="h-3 w-3" />
                <span>{`"${option.model_code}" ${t('add_new_model_prompt')}`}</span>
              </div>
            </li>
          );
        }
        const spec = option as PartSpec;
        return (
          <li key={key} {...rest}>
            <div className="flex flex-col">
              <span className="font-mono font-medium">{spec.model_code}</span>
              <span className="text-sm text-gray-600">{spec.description}</span>
            </div>
          </li>
        );
      }}
      onChange={(_, v) => {
        if (v && 'isAddNew' in v) {
          onAddNewModel(v.model_code);
          return;
        }
        onChange(v as PartSpec | null);
      }}
      value={value}
      renderInput={(params) => <TextField {...params} size="small" placeholder={t('model_search')} required />}
    />
  );
}
