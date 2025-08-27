import { useRef, useEffect } from 'react';
import type { AutocompleteSuggestion } from '@/hooks/useAutocompleteSuggestions';
import { useLang } from '@/i18n';
import { Check, Search, Hash, Package, Building } from 'lucide-react';

interface AutocompleteDropdownProps {
  suggestions: AutocompleteSuggestion[];
  isLoading: boolean;
  selectedItems: AutocompleteSuggestion[];
  onToggleItem: (item: AutocompleteSuggestion) => void;
  onSelectAll: (items: AutocompleteSuggestion[]) => void;
  visible: boolean;
  onClose: () => void;
}

const getTypeIcon = (type: string) => {
  switch (type) {
    case 'eco_no': return <Hash className="w-4 h-4 text-blue-500" />;
    case 'eco_model': return <Package className="w-4 h-4 text-green-500" />;
    case 'part_no': return <Package className="w-4 h-4 text-orange-500" />;
    case 'customer': return <Building className="w-4 h-4 text-purple-500" />;
    default: return <Search className="w-4 h-4 text-gray-400" />;
  }
};

const getTypeLabel = (type: string, lang: 'ko' | 'zh' = 'ko') => {
  const labels = {
    ko: {
      eco_no: 'ECO编号',
      eco_model: '适用型号',
      part_no: 'Part No.',
      customer: '고객사'
    },
    zh: {
      eco_no: 'ECO编号',
      eco_model: '适用型号', 
      part_no: 'Part No.',
      customer: '客户'
    }
  };
  return labels[lang][type as keyof typeof labels.ko] || type;
};

export default function AutocompleteDropdown({
  suggestions,
  isLoading,
  selectedItems,
  onToggleItem,
  onSelectAll,
  visible,
  onClose
}: AutocompleteDropdownProps) {
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { lang } = useLang();

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        onClose();
      }
    };

    if (visible) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [visible, onClose]);

  if (!visible || (!isLoading && suggestions.length === 0)) {
    return null;
  }

  return (
    <div
      ref={dropdownRef}
      className="absolute top-full left-0 right-0 z-50 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-96 overflow-y-auto"
    >
      {/* 헤더 */}
      <div className="sticky top-0 bg-gray-50 border-b border-gray-200 px-4 py-2 flex items-center justify-between">
        <span className="text-sm font-medium text-gray-700">
          {lang === 'ko' 
            ? `자동완성 결과 (${suggestions.length}개)`
            : `自动完成结果 (${suggestions.length}个)`
          }
        </span>
        {suggestions.length > 0 && (
          <button
            onClick={() => onSelectAll(suggestions)}
            className="text-xs text-blue-600 hover:text-blue-800 font-medium"
          >
            {lang === 'ko' ? '전체선택' : '全部选择'}
          </button>
        )}
      </div>

      {/* 로딩 상태 */}
      {isLoading && (
        <div className="px-4 py-3 text-center text-gray-500 text-sm">
          <div className="inline-flex items-center gap-2">
            <div className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
            {lang === 'ko' ? '검색 중...' : '搜索中...'}
          </div>
        </div>
      )}

      {/* 제안 목록 */}
      <div className="max-h-80 overflow-y-auto">
        {suggestions.map((suggestion) => {
          const isSelected = selectedItems.some(item => 
            item.value === suggestion.value && item.type === suggestion.type
          );

          return (
            <div
              key={suggestion.id}
              onClick={() => onToggleItem(suggestion)}
              className="flex items-center gap-3 px-4 py-3 hover:bg-blue-50 cursor-pointer border-b border-gray-100 last:border-b-0 transition-colors"
            >
              {/* 체크박스 */}
              <div className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${
                isSelected 
                  ? 'bg-blue-600 border-blue-600' 
                  : 'border-gray-300 hover:border-blue-400'
              }`}>
                {isSelected && <Check className="w-3 h-3 text-white" />}
              </div>

              {/* 타입 아이콘 */}
              {getTypeIcon(suggestion.type)}

              {/* 콘텐츠 */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className={`font-medium truncate ${
                    isSelected ? 'text-blue-700' : 'text-gray-900'
                  } ${suggestion.type === 'part_no' ? 'font-mono text-sm' : ''}`}>
                    {suggestion.label}
                  </span>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                    suggestion.type === 'part_no' 
                      ? 'bg-purple-100 text-purple-700'
                      : suggestion.type === 'eco_no'
                      ? 'bg-blue-100 text-blue-700'
                      : suggestion.type === 'eco_model'
                      ? 'bg-green-100 text-green-700'
                      : 'bg-gray-200 text-gray-600'
                  }`}>
                    {getTypeLabel(suggestion.type, lang)}
                  </span>
                </div>
                {suggestion.description && (
                  <div className={`text-sm truncate mt-1 ${
                    isSelected ? 'text-blue-600' : 'text-gray-500'
                  }`}>
                    {suggestion.description}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* 선택된 항목 표시 */}
      {selectedItems.length > 0 && (
        <div className="sticky bottom-0 bg-blue-50 border-t border-blue-200 px-4 py-2">
          <div className="text-sm text-blue-700">
            <span className="font-medium">{selectedItems.length}{lang === 'ko' ? '개' : '个'}</span> {lang === 'ko' ? '선택됨' : '已选择'}
          </div>
        </div>
      )}
    </div>
  );
}