import { useState, useRef } from 'react';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import EcoForm from '@/components/EcoForm';
import { useLang } from '@/i18n';
import api from '@/lib/api';
import { useUnifiedEcoSearch } from '@/hooks/useUnifiedEcoSearch';
import { useAutocompleteSuggestions, type AutocompleteSuggestion } from '@/hooks/useAutocompleteSuggestions';
import AutocompleteDropdown from '@/components/AutocompleteDropdown';
import EcoViewModal from '@/components/EcoViewModal';
import type { Eco } from '@/hooks/useEcos';
import { toast } from 'react-toastify';
import { Pencil, Trash2, Search, X, Tag, Eye } from 'lucide-react';

const ctrlCls = "h-10 bg-white border border-gray-300 rounded-md px-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500";
const rowCls = "bg-white border-t border-gray-200 hover:bg-gray-100 transition-colors";

export default function Eco2Manager() {
  const { t, lang } = useLang();
  const [keyword, setKeyword] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL'|'OPEN'|'CLOSED'>('ALL');
  
  // 자동완성 관련 상태
  const [selectedSuggestions, setSelectedSuggestions] = useState<AutocompleteSuggestion[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  
  // 자동완성 데이터
  const { data: suggestions = [], isLoading: suggestionsLoading } = useAutocompleteSuggestions(
    searchQuery, 
    showDropdown && searchQuery.length >= 2
  );
  
  // 실제 검색에 사용할 키워드 (선택된 항목들의 값들을 조합)
  const effectiveKeyword = selectedSuggestions.length > 0 
    ? selectedSuggestions.map(s => s.value).join(' ') 
    : keyword;
  
  // 통합 검색 사용
  const { data: ecos = [], isLoading, error } = useUnifiedEcoSearch(effectiveKeyword);
  
  // status filtering
  const filteredEcos = statusFilter === 'ALL' ? ecos : ecos.filter((e: any) => e.status === statusFilter);
  
  const queryClient = useQueryClient();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [viewModalOpen, setViewModalOpen] = useState(false);
  const [selectedEcoForView, setSelectedEcoForView] = useState<Eco | null>(null);
  const [errors, setErrors] = useState<Record<string,string>>({});
  const today = new Date().toISOString().slice(0,10);
  const emptyForm: Partial<Eco> = {
    eco_no: '',
    eco_model: '',
    customer: '',
    prepared_date: today,
    issued_date: today,
    received_date: today,
    due_date: '',
    status: 'OPEN',
    change_reason: '',
    change_details: '',
    applicable_work_order: '',
    storage_action: '',
    inventory_finished: null,
    inventory_material: null,
    applicable_date: '',
    form_type: 'REGULAR',
    note: '',
  };
  const [form, setForm] = useState<Partial<Eco>>(emptyForm);

  const upsert = useMutation({
    mutationFn: async (payload: Partial<Eco>) => {
      if(payload.id) {
        return api.patch(`ecos/${payload.id}/`, payload);
      }
      return api.post('ecos/', payload);
    },
    onSuccess: ()=>{
      queryClient.invalidateQueries({queryKey:['unified-eco-search']});
      queryClient.invalidateQueries({queryKey:['ecos']});
      setKeyword('');
      setDialogOpen(false);
      setErrors({});
      toast.success(t('save_success'));
    },
    onError: (err:any)=>{
      try {
        const data = err.response?.data || err.data || {};
        setErrors(data);
        const firstKey = Object.keys(data)[0];
        const firstMsg = Array.isArray(data[firstKey]) ? data[firstKey][0] : data[firstKey];
        toast.error(firstMsg || t('save_fail'));
      } catch {
        toast.error(t('save_fail'));
      }
    }
  });

  const del = useMutation({
    mutationFn: async (id:number)=> api.delete(`ecos/${id}/`),
    onSuccess: ()=>{
      queryClient.invalidateQueries({queryKey:['unified-eco-search']});
      queryClient.invalidateQueries({queryKey:['ecos']});
      toast.success(t('delete_success'));
    },
    onError: ()=>{
      toast.error(t('delete_fail'));
    }
  });

  const handleDelete = (eco:Eco)=>{
    if(!eco.id) return;
    if(!window.confirm(t('delete_confirm'))) return;
    del.mutate(eco.id);
  };

  // 자동완성 핸들러들
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setKeyword(value);
    setSearchQuery(value);
    
    if (value.length >= 2) {
      setShowDropdown(true);
    } else {
      setShowDropdown(false);
    }
  };

  const handleToggleSuggestion = (suggestion: AutocompleteSuggestion) => {
    setSelectedSuggestions(prev => {
      const exists = prev.some(item => 
        item.value === suggestion.value && item.type === suggestion.type
      );
      
      if (exists) {
        return prev.filter(item => 
          !(item.value === suggestion.value && item.type === suggestion.type)
        );
      } else {
        return [...prev, suggestion];
      }
    });
  };

  const handleSelectAllSuggestions = (items: AutocompleteSuggestion[]) => {
    setSelectedSuggestions(prev => {
      const newItems = items.filter(item => 
        !prev.some(existing => 
          existing.value === item.value && existing.type === item.type
        )
      );
      return [...prev, ...newItems];
    });
  };

  const handleRemoveSelected = (suggestion: AutocompleteSuggestion) => {
    setSelectedSuggestions(prev => 
      prev.filter(item => 
        !(item.value === suggestion.value && item.type === suggestion.type)
      )
    );
  };

  const handleClearAll = () => {
    setSelectedSuggestions([]);
    setKeyword('');
    setSearchQuery('');
  };

  // ECO 조회 핸들러
  const handleViewEco = async (eco: Eco) => {
    try {
      const { data } = await api.get(`ecos/${eco.id}/`);
      setSelectedEcoForView(data);
      setViewModalOpen(true);
    } catch (error) {
      console.error('Failed to fetch ECO details:', error);
      setSelectedEcoForView(eco);
      setViewModalOpen(true);
    }
  };


  const handleUpsert = (payload: Partial<Eco>) => {
    setErrors({});
    // header fields only
    const { details, ...headerRaw } = payload as any;
    // 빈 값 제거
    const header: Record<string, any> = {};
    Object.entries(headerRaw).forEach(([k,v])=>{
      if(v!=='' && v!==null && v!==undefined) header[k]=v;
    });
    (async ()=>{
      try{
        let ecoId = payload.id;
        if(payload.id){
          await api.patch(`ecos/${payload.id}/`, header);
        }else{
          const { data } = await api.post('ecos/', header);
          ecoId = data.id;
        }
        if(details && details.length){
          await api.post(`ecos/${ecoId}/details/bulk/`, {details});
        }
        queryClient.invalidateQueries({queryKey:['unified-eco-search']});
        queryClient.invalidateQueries({queryKey:['ecos']});
        toast.success(t('save_success'));
        setDialogOpen(false);
      }catch(err:any){
        console.error('ECO save error:', err);
        const errorData = err.response?.data || err.data || {};
        console.error('Error response:', errorData);
        
        // 에러 메시지 표시
        if (errorData && typeof errorData === 'object') {
          const firstKey = Object.keys(errorData)[0];
          const firstMsg = Array.isArray(errorData[firstKey]) ? errorData[firstKey][0] : errorData[firstKey];
          toast.error(firstMsg || t('save_fail'));
          setErrors(errorData);
        } else {
          toast.error(t('save_fail'));
        }
      }
    })();
  };

  return (
    <>
      {/* Control Bar */}
      <div className="flex flex-wrap md:flex-nowrap items-center gap-2 mb-4">
        <select value={statusFilter} onChange={e=>setStatusFilter(e.target.value as any)} className={ctrlCls}>
          <option value="ALL">{t('all')}</option>
          <option value="OPEN">OPEN</option>
          <option value="CLOSED">CLOSED</option>
        </select>
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 h-4 w-4 z-10" />
          <Input
            ref={inputRef}
            type="text"
            placeholder="🔍 통합검색: ECO编号, 适用型号, Part no. 모두 검색 가능"
            className={"pl-10 w-full "+ctrlCls}
            value={keyword}
            onChange={handleInputChange}
            onFocus={() => {
              if (keyword.length >= 2) {
                setShowDropdown(true);
              }
            }}
          />
          
          {/* 자동완성 드롭다운 */}
          <AutocompleteDropdown
            suggestions={suggestions}
            isLoading={suggestionsLoading}
            selectedItems={selectedSuggestions}
            onToggleItem={handleToggleSuggestion}
            onSelectAll={handleSelectAllSuggestions}
            visible={showDropdown}
            onClose={() => setShowDropdown(false)}
          />
        </div>
        <Button size="sm" onClick={()=>{setForm(emptyForm); setDialogOpen(true);}}>{t('new_eco')}</Button>
      </div>

      {/* 선택된 필터 태그들 */}
      {selectedSuggestions.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-gray-700">
            {lang === 'ko' ? '선택된 필터:' : '选择的过滤器:'}
          </span>
          {selectedSuggestions.map((item) => (
            <div
              key={`${item.type}-${item.value}`}
              className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-sm font-medium ${
                item.type === 'part_no'
                  ? 'bg-purple-100 text-purple-800'
                  : item.type === 'eco_no'
                  ? 'bg-blue-100 text-blue-800'
                  : item.type === 'eco_model'
                  ? 'bg-green-100 text-green-800'
                  : 'bg-gray-100 text-gray-800'
              }`}
            >
              <Tag className="w-3 h-3" />
              <span className={`${item.type === 'part_no' ? 'font-mono text-xs' : ''}`}>
                {item.label}
              </span>
              <button
                onClick={() => handleRemoveSelected(item)}
                className={`ml-1 rounded-full p-0.5 ${
                  item.type === 'part_no'
                    ? 'hover:bg-purple-200'
                    : item.type === 'eco_no'
                    ? 'hover:bg-blue-200'
                    : item.type === 'eco_model'
                    ? 'hover:bg-green-200'
                    : 'hover:bg-gray-200'
                }`}
                title={lang === 'ko' ? '제거' : '移除'}
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
          <button
            onClick={handleClearAll}
            className="text-xs text-red-600 hover:text-red-800 font-medium ml-2"
          >
            {lang === 'ko' ? '전체 지우기' : '全部清除'}
          </button>
        </div>
      )}

      {/* 검색 결과 상태 표시 */}
      <div className="mb-2 text-sm text-gray-600">
        {isLoading && (lang === 'ko' ? "검색 중..." : "搜索中...")}
        {error && (
          <span className="text-red-600">
            {lang === 'ko' ? "검색 중 오류가 발생했습니다." : "搜索时发生错误。"}
          </span>
        )}
        {!isLoading && !error && (
          <span>
            {selectedSuggestions.length > 0 
              ? lang === 'ko'
                ? `선택된 필터(${selectedSuggestions.length}개)로 검색: `
                : `通过选择的过滤器(${selectedSuggestions.length}个)搜索: `
              : keyword 
                ? lang === 'ko'
                  ? `"${keyword}" 검색 결과: ` 
                  : `"${keyword}" 搜索结果: `
                : lang === 'ko'
                  ? '최근 ECO 목록: '
                  : '最新 ECO 列表: '
            }
            {lang === 'ko' ? '총' : '共'} {filteredEcos.length}{lang === 'ko' ? '건' : '条'}
          </span>
        )}
      </div>

      {/* 카드 스타일 ECO 리스트 */}
      <div className="space-y-4">
        {filteredEcos.map((e: any) => (
          <div key={e.id} className="bg-white rounded-xl shadow-lg hover:shadow-xl transition-shadow duration-200 overflow-hidden">
            <div className="p-6">
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {/* 왼쪽: 기본 정보 */}
                <div className="space-y-4">
                  <div className="flex items-start justify-between">
                    <div>
                      <h3 
                        className="text-lg font-bold text-blue-600 cursor-pointer hover:text-blue-800 transition-colors"
                        onClick={() => handleViewEco(e)}
                        title={lang === 'ko' ? '클릭하여 조회' : '点击查看'}
                      >
                        {e.eco_no}
                      </h3>
                      <p className="text-sm text-gray-500 mt-1">
                        {t('eco_no')}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-medium ${
                        e.status === 'OPEN' ? 'bg-green-100 text-green-800' :
                        e.status === 'CLOSED' ? 'bg-gray-100 text-gray-800' :
                        'bg-yellow-100 text-yellow-800'
                      }`}>
                        {e.status}
                      </span>
                    </div>
                  </div>
                  
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <p className="text-sm font-medium text-gray-700">{t('eco_model')}</p>
                      <p className="text-sm text-gray-900 font-mono bg-gray-50 px-2 py-1 rounded mt-1">
                        {e.eco_model || '-'}
                      </p>
                    </div>
                    <div>
                      <p className="text-sm font-medium text-gray-700">{t('customer')}</p>
                      <p className="text-sm text-gray-900 mt-1">
                        {e.customer || '-'}
                      </p>
                    </div>
                  </div>
                </div>

                {/* 중앙: Part 정보 */}
                <div className="space-y-4">
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-sm font-medium text-gray-700">{t('related_part_no')}</p>
                      <span className="bg-blue-100 text-blue-800 px-2 py-1 rounded-full text-xs font-medium">
                        {e.details?.length || 0}개
                      </span>
                    </div>
                    <div className="bg-gray-50 rounded-lg p-3 max-h-20 overflow-y-auto">
                      {e.details?.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {e.details.slice(0, 4).map((detail: any, idx: number) => (
                            <span 
                              key={idx}
                              className="inline-block bg-white text-gray-700 px-2 py-1 rounded text-xs font-mono border"
                            >
                              {detail.part_no}
                            </span>
                          ))}
                          {e.details.length > 4 && (
                            <span className="inline-block bg-gray-200 text-gray-600 px-2 py-1 rounded text-xs">
                              +{e.details.length - 4}{t('more_count')}
                            </span>
                          )}
                        </div>
                      ) : (
                        <p className="text-xs text-gray-500 text-center py-2">{t('no_parts_info')}</p>
                      )}
                    </div>
                  </div>

                  <div>
                    <p className="text-sm font-medium text-gray-700 mb-2">{t('change_reason')}</p>
                    <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 max-h-16 overflow-y-auto">
                      <p className="text-xs text-gray-700">
                        {e.change_reason || t('change_reason_missing')}
                      </p>
                    </div>
                  </div>
                </div>

                {/* 오른쪽: 날짜 및 액션 */}
                <div className="space-y-4">
                  <div>
                    <p className="text-sm font-medium text-gray-700 mb-2">{t('issued_date')}</p>
                    <p className="text-sm text-gray-900 bg-gray-50 px-3 py-2 rounded-lg">
                      {e.issued_date 
                        ? new Date(e.issued_date).toLocaleDateString(lang === 'ko' ? 'ko-KR' : 'zh-CN')
                        : t('not_issued')
                      }
                    </p>
                  </div>

                  <div>
                    <p className="text-sm font-medium text-gray-700 mb-2">{t('applicable_date')}</p>
                    <p className="text-sm text-gray-900 bg-gray-50 px-3 py-2 rounded-lg">
                      {e.applicable_date 
                        ? new Date(e.applicable_date).toLocaleDateString(lang === 'ko' ? 'ko-KR' : 'zh-CN')
                        : t('not_set')
                      }
                    </p>
                  </div>

                  <div className="flex flex-col gap-2 pt-4">
                    <Button 
                      className="w-full" 
                      variant="outline" 
                      size="sm"
                      onClick={() => handleViewEco(e)}
                    >
                      <Eye className="w-4 h-4 mr-2" />
                      {t('detail_view')}
                    </Button>
                    
                    <div className="flex gap-2">
                      <Button 
                        className="flex-1" 
                        variant="outline" 
                        size="sm"
                        onClick={async () => {
                          setErrors({});
                          try{
                            const { data } = await api.get(`ecos/${e.id}/`);
                            setForm(data);
                          }catch{
                            setForm(e);
                          }
                          setDialogOpen(true);
                        }}
                      >
                        <Pencil className="w-4 h-4 mr-1" />
                        {t('edit')}
                      </Button>
                      <Button 
                        className="flex-1" 
                        variant="outline" 
                        size="sm"
                        onClick={() => handleDelete(e)}
                        disabled={del.isPending}
                      >
                        <Trash2 className="w-4 h-4 mr-1" />
                        {t('delete')}
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        ))}

        {!isLoading && filteredEcos.length === 0 && (
          <div className="bg-white rounded-xl shadow-lg p-12 text-center">
            <div className="text-gray-400 mb-4">
              <Search className="w-16 h-16 mx-auto" />
            </div>
            <p className="text-lg text-gray-600 mb-2">
              {keyword || selectedSuggestions.length > 0
                ? (lang === 'ko' ? '검색 결과가 없습니다.' : '没有搜索结果。')
                : (lang === 'ko' ? 'ECO 데이터가 없습니다.' : 'ECO 数据为空。')
              }
            </p>
            <p className="text-sm text-gray-500">
              {lang === 'ko' 
                ? '다른 검색어를 시도해보세요.' 
                : '请尝试其他搜索词。'
              }
            </p>
          </div>
        )}
      </div>

      <EcoForm
        initial={form}
        open={dialogOpen}
        onClose={()=>setDialogOpen(false)}
        onSubmit={handleUpsert}
        isSaving={upsert.isPending}
        errors={errors}
      />

      {/* ECO 조회 전용 모달 */}
      <EcoViewModal
        eco={selectedEcoForView}
        open={viewModalOpen}
        onClose={() => {
          setViewModalOpen(false);
          setSelectedEcoForView(null);
        }}
        onEdit={() => {
          // 조회 모달에서 편집 모달로 전환
          setForm(selectedEcoForView || {});
          setViewModalOpen(false);
          setSelectedEcoForView(null);
          setDialogOpen(true);
        }}
      />
    </>
  );
}