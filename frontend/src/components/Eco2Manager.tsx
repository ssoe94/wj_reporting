import { useState, useRef } from 'react';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import EcoForm from '@/components/EcoForm';
import EcoViewModal from '@/components/EcoViewModal';
import { useLang } from '@/i18n';
import PermissionButton from '@/components/common/PermissionButton';
import api from '@/lib/api';
import { useUnifiedEcoSearch } from '@/hooks/useUnifiedEcoSearch';
import type { Eco } from '@/hooks/useEcos';
import { toast } from 'react-toastify';
import { Pencil, Trash2, Search, Eye, Upload, Download, ChevronLeft, ChevronRight, PlusCircle } from 'lucide-react';
import PartMultiSelect from '@/components/PartMultiSelect';
import type { PartSpec } from '@/hooks/usePartSpecs';

const ctrlCls = "h-10 bg-white border border-gray-300 rounded-md px-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500";

// Part No Navigator 컴포넌트 - 좌우 화살표로 내비게이션
const PartNoNavigator = ({ parts }: { parts: any[] }) => {
    const [currentIndex, setCurrentIndex] = useState(0);
  
  if (!parts || parts.length === 0) {
    return <span className="text-gray-400 text-sm">-</span>;
  }
  
  const handlePrevious = () => {
    setCurrentIndex((prev) => (prev > 0 ? prev - 1 : parts.length - 1));
  };
  
  const handleNext = () => {
    setCurrentIndex((prev) => (prev < parts.length - 1 ? prev + 1 : 0));
  };
  
  return (
    <div className="flex items-center gap-1 max-w-48">
      <button 
        onClick={handlePrevious}
        className="flex-shrink-0 p-1 hover:bg-gray-100 rounded transition-colors"
        disabled={parts.length <= 1}
      >
        <ChevronLeft className={`h-3 w-3 ${parts.length <= 1 ? 'text-gray-300' : 'text-gray-500'}`} />
      </button>
      
      <div className="flex-1 text-center">
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800">
          {parts[currentIndex]?.part_no || '-'}
        </span>
      </div>
      
      <button 
        onClick={handleNext}
        className="flex-shrink-0 p-1 hover:bg-gray-100 rounded transition-colors"
        disabled={parts.length <= 1}
      >
        <ChevronRight className={`h-3 w-3 ${parts.length <= 1 ? 'text-gray-300' : 'text-gray-500'}`} />
      </button>
      
      <span className="flex-shrink-0 text-xs text-gray-500 bg-gray-50 px-1.5 py-0.5 rounded">
        {currentIndex + 1}/{parts.length}
      </span>
    </div>
  );
};

// CSV 파싱 함수들 (간소화)
const parseCSVRow = (line: string): string[] => {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];
    
    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        current += '"';
        i++; // Skip next quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  
  result.push(current.trim());
  
  return result.map(field => {
    if (field.startsWith('"') && field.endsWith('"')) {
      return field.slice(1, -1);
    }
    return field;
  });
};

const parseCSV = (content: string): Partial<Eco>[] => {
  const cleanContent = content.replace(/^\uFEFF/, '');
  const lines = cleanContent.trim().split(/\r?\n/);
  
  if (lines.length < 2) return [];
  
  const header = parseCSVRow(lines[0]);
  const requiredHeaders = ['eco_no', 'eco_model', 'customer', 'status', 'prepared_date'];
  
  if (!requiredHeaders.every(h => header.includes(h))) {
    throw new Error(`CSV must include ${requiredHeaders.join(', ')} columns.`);
  }
  
  return lines.slice(1).map(line => {
    const values = parseCSVRow(line);
    const eco: any = {};
    
    header.forEach((key, i) => {
      if (values[i] !== undefined && values[i] !== '') {
        eco[key] = values[i];
      }
    });
    
    // 기본값 설정
    if (!eco.customer || eco.customer.trim() === '') {
      eco.customer = 'N/A';
    }
    if (!eco.form_type || !['REGULAR', 'TEMP'].includes(eco.form_type)) {
      eco.form_type = 'REGULAR';
    }
    if (!eco.status || !['OPEN', 'WIP', 'CLOSED'].includes(eco.status)) {
      eco.status = 'OPEN';
    }
    
    return eco;
  });
};

export default function Eco2Manager() {
  const { t } = useLang();
  const [keyword, setKeyword] = useState('');
  const [searchType, setSearchType] = useState<'eco'|'part'|'model'|'all'>('eco');
  const [statusFilter, setStatusFilter] = useState<'ALL'|'OPEN'|'CLOSED'>('ALL');
  const [selectedPartSpecs, setSelectedPartSpecs] = useState<PartSpec[]>([]);
  const [triggerSearch, setTriggerSearch] = useState(false);

  const { data: ecos = [], isLoading: ecosLoading } = useUnifiedEcoSearch(
    searchType === 'part' ? selectedPartSpecs.map(p => p.part_no) : keyword,
    searchType,
    searchType === 'part' ? triggerSearch : true
  );

  const filteredEcos = statusFilter === 'ALL' ? ecos : ecos.filter((e: Eco) => e.status === statusFilter);
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [viewModalOpen, setViewModalOpen] = useState(false);
  const [selectedEcoForView, setSelectedEcoForView] = useState<Eco | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const today = new Date().toISOString().slice(0, 10);
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

  const del = useMutation({
    mutationFn: async (id: number) => api.delete(`ecos/${id}/`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['unified-eco-search'] });
      toast.success(t('delete_success'));
    },
    onError: () => {
      toast.error(t('delete_fail'));
    }
  });

  const bulkUpload = useMutation({
    mutationFn: (data: Partial<Eco>[]) => api.post('ecos/bulk-upload/', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['unified-eco-search'] });
      toast.success(t('bulk_upload_success'));
    },
    onError: (error: any) => {
      const errorMsg = error.response?.data?.error || t('bulk_upload_fail');
      toast.error(errorMsg);
    }
  });

  const handleDelete = (eco: Eco) => {
    if (!eco.id) return;
    if (!window.confirm(t('delete_confirm'))) return;
    del.mutate(eco.id);
  };

  const handleUpsert = async (payload: Partial<Eco>) => {
    setErrors({});
    const { details, ...headerRaw } = payload as any;
    const header: Record<string, any> = {};
    
    Object.entries(headerRaw).forEach(([k, v]) => {
      if (v !== '' && v !== null && v !== undefined) {
        if (typeof v === 'string' && v.includes('\n')) {
          v = v.replace(/\n/g, '\n');
        }
        header[k] = v;
      }
    });

    try {
      let ecoId = payload.id;
      if (payload.id) {
        await api.patch(`ecos/${payload.id}/`, header);
      } else {
        const { data } = await api.post('ecos/', header);
        ecoId = data.id;
      }
      if (details && details.length) {
        await api.post(`ecos/${ecoId}/details/bulk/`, { details });
      }
      queryClient.invalidateQueries({ queryKey: ['unified-eco-search'] });
      toast.success(t('save_success'));
      setDialogOpen(false);
    } catch (err: any) {
      const errorData = err.response?.data || err.data || {};
      if (errorData && typeof errorData === 'object') {
        const firstKey = Object.keys(errorData)[0];
        const firstMsg = Array.isArray(errorData[firstKey]) ? errorData[firstKey][0] : errorData[firstKey];
        toast.error(firstMsg || t('save_fail'));
        setErrors(errorData);
      } else {
        toast.error(t('save_fail'));
      }
    }
  };

  const handleViewEco = (eco: Eco) => {
    setSelectedEcoForView(eco);
    setViewModalOpen(true);
  };

  const handleDownloadCSV = () => {
    const headers = ['eco_no', 'eco_model', 'customer', 'status', 'prepared_date', 'issued_date', 'change_reason', 'change_details'];
    const csvContent = [
      headers.join(','),
      ...filteredEcos.map(eco => headers.map(h => `"${(eco as any)[h] || ''}"`).join(','))
    ].join('\n');
    
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `eco_list_${new Date().toISOString().slice(0, 10)}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const content = e.target?.result as string;
        const parsedData = parseCSV(content);
        if (parsedData.length > 0) {
          bulkUpload.mutate(parsedData);
        }
      } catch (error: any) {
        toast.error(error.message || t('csv_parse_fail'));
      }
    };
    reader.readAsText(file, 'UTF-8');
    event.target.value = '';
  };

  return (
    <>
      <div className="flex flex-wrap md:flex-nowrap items-center gap-2 mb-4">
        <select value={searchType} onChange={e => {
            const newSearchType = e.target.value as 'eco' | 'part' | 'model' | 'all';
            setSearchType(newSearchType);
            setKeyword(''); // Clear keyword when search type changes
            setSelectedPartSpecs([]); // Clear selected part specs when search type changes
            setTriggerSearch(false); // Reset triggerSearch
        }} className={ctrlCls}>
          
          <option value="eco">{t('eco_no')}</option>
          <option value="part">PART NO.</option>
          <option value="model">适用型号</option>
        </select>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value as any)} className={ctrlCls}>
          <option value="ALL">{t('all')}</option>
          <option value="OPEN">OPEN</option>
          <option value="CLOSED">CLOSED</option>
        </select>
        <div className="relative flex-1 min-w-[180px]">
          {searchType === 'part' ? (
              <PartMultiSelect onAdd={(parts) => { setSelectedPartSpecs(parts); setTriggerSearch(true); }} />
          ) : (
              <>
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 h-4 w-4" />
                  <Input
                      type="text"
                      placeholder={
                          searchType === 'eco' ? t('eco_search_placeholder') : 
                          searchType === 'model' ? '适用型号 검색...' :
                          '통합 검색...'
                      }
                      className={"pl-10 w-full " + ctrlCls}
                      value={keyword}
                      onChange={(e) => setKeyword(e.target.value)}
                  />
              </>
          )}
        </div>
        {searchType === 'part' && (
          <div className="flex items-center gap-2">
            {selectedPartSpecs.length > 0 && (
              <div className="hidden md:flex items-center gap-1 text-xs text-gray-600">
                <button 
                  type="button"
                  onClick={() => {
                    const list = selectedPartSpecs.map(p => `${p.part_no}${p.description ? ` - ${p.description}` : ''}`).join('\n');
                    alert(list || '');
                  }}
                  className="px-2 py-1 bg-gray-100 rounded hover:bg-gray-200 transition-colors"
                  title={selectedPartSpecs.map(p=>p.part_no).join(', ')}
                >
                  {selectedPartSpecs.length} selected
                </button>
              </div>
            )}
            <Button size="sm" onClick={() => setTriggerSearch(true)} className="ml-2">
              {t('search')}
            </Button>
          </div>
        )}
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => fileInputRef.current?.click()} variant="ghost" disabled={bulkUpload.isPending}>
            <Upload className="w-4 h-4 mr-2" />
            {bulkUpload.isPending ? t('uploading') : t('bulk_upload')}
          </Button>
          <input type="file" ref={fileInputRef} onChange={handleFileUpload} className="hidden" accept=".csv" />
          <Button size="sm" onClick={handleDownloadCSV} variant="ghost">
            <Download className="w-4 h-4 mr-2" />
            {t('download_csv')}
          </Button>
          <PermissionButton
            permission="can_edit_eco"
            onClick={() => { setForm(emptyForm); setDialogOpen(true); }}
            className="px-3 py-2 bg-blue-600 text-white hover:bg-blue-700 rounded-md font-medium transition-all duration-200 inline-flex items-center gap-2 whitespace-nowrap"
          >
            <PlusCircle className="w-4 h-4 shrink-0" />
            {t('new_eco')}
          </PermissionButton>
        </div>
      </div>
      
      <div className="bg-white rounded-lg shadow-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gradient-to-r from-blue-50 to-indigo-50">
              <tr>
                <th className="px-3 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">{t('eco_no')}</th>
                <th className="px-3 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">{t('eco_model')}</th>
                <th className="px-3 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Part No.</th>
                <th className="px-3 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">{t('change_reason')}</th>
                <th className="px-3 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">{t('change_details')}</th>
                <th className="px-3 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">{t('applicable_date')}</th>
                <th className="px-3 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">{t('status')}</th>
                <th className="px-3 py-3 text-center text-xs font-semibold text-gray-700 uppercase tracking-wider">작업</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {ecosLoading ? (
                <tr>
                  <td colSpan={8} className="text-center py-8">
                    <div className="flex items-center justify-center space-x-2">
                      <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-500"></div>
                      <span className="text-gray-500 text-sm">Loading...</span>
                    </div>
                  </td>
                </tr>
              ) : filteredEcos.length === 0 ? (
                <tr>
                  <td colSpan={8} className="text-center py-8">
                    <span className="text-gray-500 text-sm">
                      {searchType === 'part' && selectedPartSpecs.length > 0
                        ? '선택한 Part No.에 해당하는 ECO가 없습니다.'
                        : (keyword ? '검색 결과가 없습니다.' : 'ECO를 검색해주세요.')}
                    </span>
                  </td>
                </tr>
              ) : filteredEcos.map((e: Eco) => (
                <tr key={e.id} className="bg-white hover:bg-blue-50/30 transition-colors duration-150">
                  <td className="px-3 py-3 whitespace-nowrap">
                    <button 
                      onClick={() => handleViewEco(e)}
                      className="font-mono text-sm font-semibold text-blue-600 hover:text-blue-800 hover:underline transition-colors"
                    >
                      {e.eco_no}
                    </button>
                  </td>
                  <td className="px-3 py-3 whitespace-nowrap">
                    <span className="text-sm font-medium text-gray-900">{e.eco_model}</span>
                  </td>
                  <td className="px-2 py-3">
                    <PartNoNavigator parts={e.details || []} />
                  </td>
                  <td className="px-3 py-3 max-w-xs">
                    <div className="text-sm text-gray-900">
                      <p className="line-clamp-2 leading-relaxed" title={e.change_reason || ''}>
                        {e.change_reason}
                      </p>
                    </div>
                  </td>
                  <td className="px-3 py-3 max-w-md">
                    <div className="text-sm text-gray-700">
                      <p className="line-clamp-2 leading-relaxed" title={e.change_details || ''}>
                        {e.change_details}
                      </p>
                    </div>
                  </td>
                  <td className="px-3 py-3 whitespace-nowrap">
                    <span className="text-sm font-medium text-gray-900">{(e as any).applicable_date || '-'}</span>
                  </td>
                  <td className="px-3 py-3 whitespace-nowrap">
                    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${
                      e.status === 'OPEN' ? 'bg-blue-100 text-blue-800' :
                      e.status === 'WIP' ? 'bg-yellow-100 text-yellow-800' :
                      'bg-green-100 text-green-800'
                    }`}>
                      {e.status}
                    </span>
                  </td>
                  <td className="px-3 py-3 whitespace-nowrap text-center">
                    <div className="flex items-center justify-center space-x-1">
                      <Button 
                        size="icon" 
                        variant="ghost" 
                        onClick={() => handleViewEco(e)}
                        className="h-8 w-8 hover:bg-blue-100 hover:text-blue-600 rounded-full"
                        aria-label={t('view')}
                      >
                        <Eye className="w-4 h-4" />
                      </Button>
                      <PermissionButton
                        permission="can_edit_eco"
                        onClick={async () => {
                          setErrors({});
                          try {
                            const { data } = await api.get(`ecos/${e.id}/`);
                            setForm(data);
                          } catch {
                            setForm(e);
                          }
                          setDialogOpen(true);
                        }} 
                        className="h-8 w-8 hover:bg-amber-100 hover:text-amber-600 rounded-full p-0"
                      >
                        <Pencil className="w-4 h-4" />
                      </PermissionButton>
                      <PermissionButton
                        permission="can_edit_eco"
                        onClick={() => handleDelete(e)} 
                        className="h-8 w-8 hover:bg-red-100 hover:text-red-600 rounded-full p-0"
                        disabled={del.isPending}
                      >
                        <Trash2 className="w-4 h-4" />
                      </PermissionButton>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <EcoForm
        initial={form}
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSubmit={handleUpsert}
        isSaving={false}
        errors={errors}
      />

      <EcoViewModal
        eco={selectedEcoForView}
        open={viewModalOpen}
        onClose={() => setViewModalOpen(false)}
        onEdit={() => {
          if (selectedEcoForView) {
            setViewModalOpen(false);
            setForm(selectedEcoForView);
            setDialogOpen(true);
          }
        }}
      />
    </>
  );
}
