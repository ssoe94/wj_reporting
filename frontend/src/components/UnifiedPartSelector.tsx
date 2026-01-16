import { useState, useMemo } from 'react';
import { Autocomplete, TextField } from '@mui/material';
import { Plus } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import api from '../lib/api';
import { toast } from 'react-toastify';
import { useLang } from '../i18n';

export interface UnifiedPartSpec {
  id: number;
  part_no: string;
  model_code: string;
  description: string;
  display_name: string;
  source_system: 'injection' | 'assembly' | 'quality' | 'unified';
  is_active: boolean;
  valid_from: string;
  color?: string;
  // 사출 관련 필드들
  mold_type?: string;
  resin_type?: string;
  resin_code?: string;
  net_weight_g?: number;
  sr_weight_g?: number;
  cycle_time_sec?: number;
  cavity?: number;
  tonnage?: number;
  efficiency_rate?: number;
  resin_loss_pct?: number;
  defect_rate_pct?: number;
  // 가공 관련 필드들  
  process_type?: string;
  material_type?: string;
  standard_cycle_time?: number;
  standard_worker_count?: number;
}

interface UnifiedPartSelectorProps {
  value?: UnifiedPartSpec | null;
  onChange?: (part: UnifiedPartSpec | null) => void;
  onModelChange?: (modelCode: string, description: string) => void;
  onPartChange?: (partNo: string) => void;
  mode?: 'all' | 'injection' | 'assembly' | 'quality'; // 시스템별 필터링
  searchMode?: 'part' | 'model' | 'both'; // 검색 모드
  placeholder?: string;
  size?: 'small' | 'medium';
  disabled?: boolean;
  required?: boolean;
  allowCreate?: boolean; // 새 Part 생성 허용 여부
}

export default function UnifiedPartSelector({
  value,
  onChange,
  onModelChange,
  onPartChange,
  mode = 'all',
  searchMode = 'both',
  placeholder = 'Part No / Model 검색',
  size = 'small',
  disabled = false,
  required = false,
  allowCreate = true
}: UnifiedPartSelectorProps) {
  const { t, lang } = useLang();
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newPartForm, setNewPartForm] = useState({
    part_no: '',
    model_code: '',
    description: ''
  });

  // 통합 품목 검색 API
  const { data: searchResults = [], isLoading } = useQuery({
    queryKey: ['unified-parts-search', searchQuery, mode],
    queryFn: async () => {
      if (!searchQuery || searchQuery.length < 2) return [];

      const { data } = await api.get('/inventory/unified-parts/search/', {
        params: {
          q: searchQuery,
          mode,
          limit: 50
        }
      });
      return data as UnifiedPartSpec[];
    },
    enabled: searchQuery.length >= 2,
    staleTime: 30000, // 30초 캐시
  });

  // 옵션 리스트 생성 (새 항목 추가 옵션 포함)
  const options = useMemo(() => {
    const opts: (UnifiedPartSpec | { isAddNew: true; searchQuery: string })[] = [...searchResults];

    // 새 항목 추가 옵션 (검색어가 있고, 허용되는 경우)
    if (allowCreate && searchQuery.trim().length >= 2 && searchResults.length === 0) {
      opts.push({ isAddNew: true, searchQuery: searchQuery.trim() });
    }

    return opts;
  }, [searchResults, allowCreate, searchQuery]);

  // 새 Part 생성 핸들러
  const handleCreateNewPart = async () => {
    const { part_no, model_code, description } = newPartForm;

    if (!part_no.trim() || !model_code.trim()) {
      toast.error(lang === 'zh' ? '请填写 Part No 和 Model Code' : 'Part No와 Model Code를 입력하세요');
      return;
    }

    try {
      const { data } = await api.post('/inventory/unified-parts/', {
        part_no: part_no.trim(),
        model_code: model_code.trim(),
        description: description.trim(),
        source_system: mode === 'all' ? 'unified' : mode,
      });

      // 캐시 무효화
      queryClient.invalidateQueries({ queryKey: ['unified-parts-search'] });

      // 생성된 Part 선택
      onChange?.(data as UnifiedPartSpec);
      onModelChange?.(data.model_code, data.description);
      onPartChange?.(data.part_no);

      setShowCreateModal(false);
      setNewPartForm({ part_no: '', model_code: '', description: '' });

      toast.success(lang === 'zh' ? '已添加新的 Part' : '새로운 Part가 추가되었습니다');

    } catch (error: any) {
      console.error('Part 생성 실패:', error);
      toast.error(error.response?.data?.error || (lang === 'zh' ? '添加失败' : '추가에 실패했습니다'));
    }
  };

  return (
    <>
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
          return searchMode === 'part' ? option.part_no :
            searchMode === 'model' ? `${option.model_code} - ${option.description}` :
              option.display_name;
        }}

        // 옵션 동일성 비교
        isOptionEqualToValue={(option, value) => {
          if ('isAddNew' in option || 'isAddNew' in value) return false;
          return option.part_no === value?.part_no;
        }}

        // 입력 변경 핸들러
        onInputChange={(_, newInputValue) => {
          setSearchQuery(newInputValue);
        }}

        // 선택 변경 핸들러
        onChange={(_, newValue) => {
          if (newValue && 'isAddNew' in newValue) {
            // 새 항목 추가 모달 표시
            setNewPartForm(prev => ({
              ...prev,
              part_no: newValue.searchQuery,
              model_code: newValue.searchQuery
            }));
            setShowCreateModal(true);
            return;
          }

          const selectedPart = newValue as UnifiedPartSpec | null;
          onChange?.(selectedPart);

          if (selectedPart) {
            onModelChange?.(selectedPart.model_code, selectedPart.description);
            onPartChange?.(selectedPart.part_no);
          }
        }}

        // 렌더링 설정
        renderInput={(params) => (
          <TextField
            {...params}
            placeholder={placeholder}
            required={required}
            error={required && !value}
            helperText={required && !value ? (lang === 'zh' ? '请选择 Part' : 'Part를 선택하세요') : ''}
          />
        )}

        renderOption={(props, option) => {
          const { ...restProps } = props as any;

          if ('isAddNew' in option) {
            return (
              <li {...restProps} className="bg-green-50 hover:bg-green-100 border-t border-green-200">
                <div className="flex items-center justify-center gap-2 text-green-700 font-medium py-2 text-sm">
                  <Plus className="h-3 w-3" />
                  <span>"{option.searchQuery}" {t('add_new_part_prompt')}</span>
                </div>
              </li>
            );
          }

          return (
            <li {...restProps}>
              <div className="flex flex-col w-full">
                <div className="flex items-center justify-between">
                  <span className="font-mono font-medium">{option.part_no}</span>
                  <span className="text-xs text-gray-500 bg-gray-100 px-1 rounded">
                    {option.source_system === 'injection' ? '사출' :
                      option.source_system === 'assembly' ? '가공' :
                        option.source_system === 'quality' ? '품질' : '통합'}
                  </span>
                </div>
                <span className="text-sm text-gray-600">
                  {option.model_code}{option.description ? ` - ${option.description}` : ''}
                </span>
              </div>
            </li>
          );
        }}
      />

      {/* 새 Part 생성 모달 */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg w-[420px] p-6 space-y-4">
            <h3 className="text-lg font-semibold mb-2">{t('add_new_part_spec')}</h3>
            <p className="text-xs text-gray-500">
              {lang === 'zh' ? '必填: Part No / Model Code' : '필수: Part No / Model Code'}
            </p>

            <div className="space-y-3">
              <input
                placeholder="Part No"
                className="w-full border rounded px-3 py-2 bg-green-50 border-green-300"
                value={newPartForm.part_no}
                onChange={(e) => setNewPartForm(prev => ({ ...prev, part_no: e.target.value }))}
              />
              <input
                placeholder="Model Code"
                className="w-full border rounded px-3 py-2"
                value={newPartForm.model_code}
                onChange={(e) => setNewPartForm(prev => ({ ...prev, model_code: e.target.value }))}
              />
              <input
                placeholder="Description (선택사항)"
                className="w-full border rounded px-3 py-2"
                value={newPartForm.description}
                onChange={(e) => setNewPartForm(prev => ({ ...prev, description: e.target.value }))}
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                className="px-3 py-1 text-sm"
                onClick={() => setShowCreateModal(false)}
              >
                {t('cancel')}
              </button>
              <button
                className="px-3 py-1 bg-blue-600 text-white text-sm rounded"
                onClick={handleCreateNewPart}
              >
                {t('save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
