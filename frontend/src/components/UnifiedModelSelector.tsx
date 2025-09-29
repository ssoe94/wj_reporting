import React, { useState } from 'react';
import { Autocomplete, TextField } from '@mui/material';
import { Plus } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import api from '../lib/api';
import { useLang } from '../i18n';

export interface UnifiedModel {
  model_code: string;
  description: string;
  display_name: string;
}

interface UnifiedModelSelectorProps {
  value?: UnifiedModel | null;
  onChange?: (model: UnifiedModel | null) => void;
  onModelChange?: (modelCode: string, description: string) => void;
  placeholder?: string;
  size?: 'small' | 'medium';
  disabled?: boolean;
  required?: boolean;
  allowCreate?: boolean;
}

export default function UnifiedModelSelector({
  value,
  onChange,
  onModelChange,
  placeholder = 'Model 검색',
  size = 'small',
  disabled = false,
  required = false,
  allowCreate = true
}: UnifiedModelSelectorProps) {
  const { t, lang } = useLang();
  const [searchQuery, setSearchQuery] = useState('');

  // 통합 모델 검색 API
  const { data: searchResults = [], isLoading } = useQuery({
    queryKey: ['unified-models', searchQuery],
    queryFn: async () => {
      if (!searchQuery || searchQuery.length < 2) return [];
      
      const { data } = await api.get('/mes/unified-parts/models/', {
        params: { search: searchQuery }
      });
      return data as UnifiedModel[];
    },
    enabled: searchQuery.length >= 2,
    staleTime: 30000, // 30초 캐시
  });

  // 옵션 리스트 생성 (새 모델 추가 옵션 포함)
  const options = React.useMemo(() => {
    let opts: (UnifiedModel | { isAddNew: true; searchQuery: string })[] = [...searchResults];
    
    // 새 모델 추가 옵션 (검색어가 있고, 허용되는 경우, 결과가 없는 경우)
    if (allowCreate && searchQuery.trim().length >= 2 && searchResults.length === 0) {
      opts.push({ isAddNew: true, searchQuery: searchQuery.trim() });
    }
    
    return opts;
  }, [searchResults, allowCreate, searchQuery]);

  return (
    <Autocomplete
      value={value}
      options={options}
      loading={isLoading}
      disabled={disabled}
      size={size}
      openOnFocus
      clearOnBlur={false}
      handleHomeEndKeys
      
      // 옵션 레이블 설정
      getOptionLabel={(option) => {
        if ('isAddNew' in option) return option.searchQuery;
        return option.display_name;
      }}
      
      // 옵션 동일성 비교
      isOptionEqualToValue={(option, value) => {
        if ('isAddNew' in option || 'isAddNew' in value) return false;
        return option.model_code === value?.model_code && 
               (option.description || '') === (value?.description || '');
      }}
      
      // 입력 변경 핸들러
      onInputChange={(_, newInputValue) => {
        setSearchQuery(newInputValue);
      }}
      
      // 선택 변경 핸들러
      onChange={(_, newValue) => {
        if (newValue && 'isAddNew' in newValue) {
          // 새 모델 생성 (임시 객체)
          const newModel: UnifiedModel = {
            model_code: newValue.searchQuery,
            description: '',
            display_name: newValue.searchQuery
          };
          onChange?.(newModel);
          onModelChange?.(newModel.model_code, newModel.description);
          return;
        }
        
        const selectedModel = newValue as UnifiedModel | null;
        onChange?.(selectedModel);
        
        if (selectedModel) {
          onModelChange?.(selectedModel.model_code, selectedModel.description);
        }
      }}
      
      // 렌더링 설정
      renderInput={(params) => (
        <TextField
          {...params}
          placeholder={placeholder}
          required={required}
          error={required && !value}
          helperText={required && !value ? (lang === 'zh' ? '请选择 Model' : 'Model을 선택하세요') : ''}
        />
      )}
      
      renderOption={(props, option) => {
        const { key, ...restProps } = props as any;
        
        if ('isAddNew' in option) {
          return (
            <li key={key} {...restProps} className="bg-green-50 hover:bg-green-100 border-t border-green-200">
              <div className="flex items-center justify-center gap-2 text-green-700 font-medium py-2 text-sm">
                <Plus className="h-3 w-3" />
                <span>"{option.searchQuery}" {t('add_new_model_prompt')}</span>
              </div>
            </li>
          );
        }

        return (
          <li key={key} {...restProps}>
            <div className="flex flex-col">
              <span className="font-mono font-medium">{option.model_code}</span>
              {option.description && (
                <span className="text-sm text-gray-600">{option.description}</span>
              )}
            </div>
          </li>
        );
      }}
    />
  );
}