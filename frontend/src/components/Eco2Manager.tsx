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
              className="inline-flex items-center gap-1 bg-blue-100 text-blue-800 px-2 py-1 rounded-full text-sm"
            >
              <Tag className="w-3 h-3" />
              <span className="font-medium">{item.label}</span>
              <button
                onClick={() => handleRemoveSelected(item)}
                className="ml-1 hover:bg-blue-200 rounded-full p-0.5"
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

      <div className="bg-white rounded-lg shadow-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-slate-100">
              <tr>
                <th className="px-3 py-2 text-left">{t('eco_no')}</th>
                <th className="px-3 py-2 text-left">{t('eco_model')}</th>
                <th className="px-3 py-2 text-left">{t('customer')}</th>
                <th className="px-3 py-2 text-left">{t('change_reason')}</th>
                <th className="px-3 py-2 text-left">{t('issued_date')}</th>
                <th className="px-3 py-2 text-left">{t('status')}</th>
                <th className="px-3 py-2 text-left">Part 개수</th>
                <th className="px-3 py-2 text-left"></th>
              </tr>
            </thead>
            <tbody>
              {filteredEcos.map((e: any)=>(
                <tr key={e.id} className={rowCls}>
                  <td className="px-3 py-1 font-mono cursor-pointer text-blue-600 underline hover:text-blue-800" 
                      onClick={() => handleViewEco(e)}
                      title={lang === 'ko' ? '클릭하여 조회' : '点击查看'}>
                    {e.eco_no}
                  </td>
                  <td className="px-3 py-1">{e.eco_model || '-'}</td>
                  <td className="px-3 py-1">{e.customer || '-'}</td>
                  <td className="px-3 py-1 max-w-[200px] truncate">{e.change_reason}</td>
                  <td className="px-3 py-1">{e.issued_date}</td>
                  <td className="px-3 py-1">
                    <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                      e.status === 'OPEN' ? 'bg-green-100 text-green-800' :
                      e.status === 'CLOSED' ? 'bg-gray-100 text-gray-800' :
                      'bg-yellow-100 text-yellow-800'
                    }`}>
                      {e.status}
                    </span>
                  </td>
                  <td className="px-3 py-1 text-center">
                    {e.details ? e.details.length : 0}
                  </td>
                  <td className="px-3 py-1 text-right flex justify-end gap-1">
                    <Button 
                      size="icon" 
                      variant="ghost" 
                      onClick={() => handleViewEco(e)} 
                      aria-label={lang === 'ko' ? '조회' : '查看'}
                      title={lang === 'ko' ? '조회' : '查看'}
                    >
                      <Eye className="w-4 h-4 text-blue-600" />
                    </Button>
                    <Button size="icon" variant="ghost" onClick={async ()=>{
                      setErrors({});
                      try{
                        const { data } = await api.get(`ecos/${e.id}/`);
                        setForm(data);
                      }catch{
                        setForm(e);
                      }
                      setDialogOpen(true);
                    }} aria-label={t('edit')} title={t('edit')}>
                      <Pencil className="w-4 h-4 text-gray-600" />
                    </Button>
                    <Button 
                      size="icon" 
                      variant="ghost" 
                      onClick={()=>handleDelete(e)} 
                      aria-label={t('delete')} 
                      title={t('delete')}
                      disabled={del.isPending}
                    >
                      <Trash2 className="w-4 h-4 text-red-600" />
                    </Button>
                  </td>
                </tr>
              ))}
              {!isLoading && filteredEcos.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-8 text-center text-gray-500">
                    {keyword 
                      ? (lang === 'ko' ? '검색 결과가 없습니다.' : '没有搜索结果。')
                      : (lang === 'ko' ? 'ECO 데이터가 없습니다.' : 'ECO 数据为空。')
                    }
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
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