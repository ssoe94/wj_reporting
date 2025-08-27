import { useState, useRef } from 'react';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import EcoForm from '@/components/EcoForm';
import EcoViewModal from '@/components/EcoViewModal';
import { useLang } from '@/i18n';
import api from '@/lib/api';
import { useEcos } from '@/hooks/useEcos';
import { useEcosByPart } from '@/hooks/useEcosByPart';
import { usePartEcoCount } from '@/hooks/usePartEcoCount';
import { useEcosByParts } from '@/hooks/useEcosByParts';
import type { Eco } from '@/hooks/useEcos';
import { toast } from 'react-toastify';
import { Pencil, Trash2, Search, Eye, Upload, Download } from 'lucide-react';

const ctrlCls = "h-10 bg-white border border-gray-300 rounded-md px-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500";
const rowCls = "bg-white border-t border-gray-200 hover:bg-gray-100 transition-colors";

// Change Details에서 Part 정보를 추출하는 함수
const extractPartDetailsFromChangeDetails = (changeDetails: string): any[] => {
  const parts: any[] = [];
  
  if (!changeDetails) return parts;
  
  // Part No 패턴 찾기 (예: ACQ30154848, MCK714219 등)
  const partNoPattern = /([A-Z]{2,4}\d{6,12}[A-Z*]*)/g;
  const foundPartNos = [...changeDetails.matchAll(partNoPattern)];
  
  if (foundPartNos.length > 0) {
    // 각 Part No에 대해 상세 정보 추출
    foundPartNos.forEach((match, index) => {
      const partNo = match[1];
      
      // 괄호 안의 설명 찾기 (예: (MCK714219**))
      const descriptionPattern = new RegExp(`\\(([^)]*${partNo.substring(0, 6)}[^)]*)\\)`, 'i');
      const descriptionMatch = changeDetails.match(descriptionPattern);
      
      // Part별 변경내용 - 전체 change_details를 사용하되 Part No 별로 구분이 어려우므로 전체 내용 사용
      let partChangeDetails = changeDetails;
      
      // 만약 여러 Part가 있다면 Part No 이후의 내용만 추출 시도
      if (foundPartNos.length > 1) {
        const nextPartIndex = index < foundPartNos.length - 1 ? foundPartNos[index + 1].index : changeDetails.length;
        const currentPartIndex = match.index || 0;
        partChangeDetails = changeDetails.substring(currentPartIndex, nextPartIndex).trim();
      }
      
      parts.push({
        part_no: partNo,
        description: descriptionMatch ? descriptionMatch[1] : '',
        change_details: partChangeDetails,
        status: 'OPEN' // 기본값
      });
    });
  } else {
    // Part No 패턴을 찾을 수 없는 경우, 전체 내용을 하나의 Part로 처리
    // 변경내용에서 대표적인 부품 정보 추출 시도
    const generalPartMatch = changeDetails.match(/([A-Z]\w*\s*\w*)/);
    parts.push({
      part_no: generalPartMatch ? generalPartMatch[1] : 'Unknown',
      description: '',
      change_details: changeDetails,
      status: 'OPEN'
    });
  }
  
  return parts;
};

// More robust CSV parser that handles quoted strings and multiline content
const parseCSV = (content: string): Partial<Eco>[] => {
  // Remove BOM if present
  const cleanContent = content.replace(/^\uFEFF/, '');
  const text = cleanContent.trim();
  
  if (!text) return [];
  
  // Parse CSV with proper quote handling for multiline fields
  const rows: string[] = [];
  let currentRow = '';
  let inQuotes = false;
  
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];
    
    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        // Escaped quote
        currentRow += '"';
        i++; // Skip next quote
      } else {
        inQuotes = !inQuotes;
      }
      currentRow += char;
    } else if ((char === '\r' || char === '\n') && !inQuotes) {
      if (currentRow.trim()) {
        rows.push(currentRow);
        currentRow = '';
      }
      if (char === '\r' && nextChar === '\n') {
        i++; // Skip \n after \r
      }
    } else {
      currentRow += char;
    }
  }
  
  if (currentRow.trim()) {
    rows.push(currentRow);
  }
  
  if (rows.length < 2) return [];
  
  const header = parseCSVRow(rows[0]);
  console.log("CSV Header:", header);
  
  const requiredHeaders = ['eco_no', 'eco_model', 'customer', 'status', 'prepared_date', 'issued_date'];
  if (!requiredHeaders.every(h => header.includes(h))) {
    throw new Error(`CSV must include ${requiredHeaders.join(', ')} columns.`);
  }
  
  return rows.slice(1).map((line, index) => {
    const values = parseCSVRow(line);
    console.log(`Row ${index + 1} values:`, values);
    
    const eco: any = {};
    header.forEach((key, i) => {
      if (values[i] !== undefined && values[i] !== '') {
        eco[key] = values[i];
      }
    });
    
    // 필수 필드에 기본값 설정
    if (!eco.customer || eco.customer.trim() === '') {
      eco.customer = 'N/A';
    }
    
    // form_type 필드 처리 - 잘못된 값이 들어간 경우 수정
    if (!eco.form_type || eco.form_type.trim() === '') {
      eco.form_type = 'REGULAR';
    } else if (eco.form_type === 'CLOSED' || eco.form_type === 'OPEN') {
      // CSV에서 form_type에 status 값이 들어간 경우 수정
      if (!eco.status || eco.status.trim() === '') {
        eco.status = eco.form_type; // form_type을 status로 이동
      }
      eco.form_type = 'REGULAR';
    } else if (!['REGULAR', 'TEMP'].includes(eco.form_type)) {
      eco.form_type = 'REGULAR';
    }
    
    // status 필드 검증
    if (!eco.status || !['OPEN', 'WIP', 'CLOSED'].includes(eco.status)) {
      eco.status = 'OPEN';
    }
    
    // 날짜 필드 포맷 정리 (YYYY-MM-DD)
    const dateFields = ['prepared_date', 'issued_date', 'received_date', 'applicable_date', 'due_date', 'close_date'];
    dateFields.forEach(field => {
      if (eco[field] && eco[field].trim() !== '') {
        const dateValue = eco[field].trim();
        // 이미 YYYY-MM-DD 형식인지 확인
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
          try {
            // 다양한 형식을 YYYY-MM-DD로 변환
            const date = new Date(dateValue);
            if (!isNaN(date.getTime())) {
              eco[field] = date.toISOString().split('T')[0];
            } else {
              eco[field] = null; // 잘못된 날짜는 null로 설정
            }
          } catch (error) {
            eco[field] = null; // 파싱 실패시 null
          }
        }
      } else if (eco[field] === '') {
        eco[field] = null; // 빈 문자열은 null로 변환
      }
    });
    
    // Change Details에서 Part 정보 추출
    if (eco.change_details && eco.change_details.trim() !== '') {
      eco.part_details = extractPartDetailsFromChangeDetails(eco.change_details);
    }
    
    return eco;
  });
};

// Helper function to parse a single CSV row
const parseCSVRow = (row: string): string[] => {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < row.length; i++) {
    const char = row[i];
    const nextChar = row[i + 1];
    
    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        // Escaped quote
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
  
  // Remove quotes from the start and end of each field
  return result.map(field => {
    if (field.startsWith('"') && field.endsWith('"')) {
      return field.slice(1, -1);
    }
    return field;
  });
};

export default function EcoManager() {
  const { t } = useLang();
  const [keyword, setKeyword] = useState('');
  const [mode, setMode] = useState<'eco'|'part'>('eco');
  const [statusFilter, setStatusFilter] = useState<'ALL'|'OPEN'|'CLOSED'>('ALL');
  const [selectedParts, setSelectedParts] = useState<string[]>([]);
  const [selectedPart, setSelectedPart] = useState<string>('');
  const { data: ecos = [], isLoading: ecosLoading } = mode === 'eco' ? useEcos(keyword) : useEcosByPart(selectedPart || '');
  const filteredEcos = statusFilter === 'ALL' ? ecos : ecos.filter((e: Eco) => e.status === statusFilter);
  const { data: partCounts = [] } = usePartEcoCount(mode === 'part' ? keyword : '');
  const ecosBySelectedParts = useEcosByParts(selectedParts);
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

  const upsert = useMutation({
    mutationFn: async (payload: Partial<Eco>) => {
      if (payload.id) {
        return api.patch(`ecos/${payload.id}/`, payload);
      }
      return api.post('ecos/', payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ecos'] });
      setKeyword('');
      setDialogOpen(false);
      setErrors({});
      toast.success(t('save_success'));
    },
    onError: (err: any) => {
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
    mutationFn: async (id: number) => api.delete(`ecos/${id}/`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ecos'] });
      toast.success(t('delete_success'));
    },
    onError: () => {
      toast.error(t('delete_fail'));
    }
  });

  const bulkUpload = useMutation({
    mutationFn: (data: Partial<Eco>[]) => api.post('ecos/bulk-upload/', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ecos'] });
      toast.success(t('bulk_upload_success'));
    },
    onError: (error: any) => {
      console.error('Bulk upload error:', error);
      console.error('Error response:', error.response?.data);
      const errorMsg = error.response?.data?.error || t('bulk_upload_fail');
      toast.error(errorMsg);
    }
  });

  const handleDelete = (eco: Eco) => {
    if (!eco.id) return;
    if (!window.confirm(t('delete_confirm'))) return;
    del.mutate(eco.id);
  };

  const handleUpsert = (payload: Partial<Eco>) => {
    setErrors({});
    const { details, ...headerRaw } = payload as any;
    const header: Record<string, any> = {};
    Object.entries(headerRaw).forEach(([k, v]) => {
      if (v !== '' && v !== null && v !== undefined) header[k] = v;
    });
    (async () => {
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
        queryClient.invalidateQueries({ queryKey: ['ecos'] });
        toast.success(t('save_success'));
        setDialogOpen(false);
      } catch (err: any) {
        console.error('ECO save error:', err);
        const errorData = err.response?.data || err.data || {};
        console.error('Error response:', errorData);
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

  const handleViewEco = async (eco: Eco) => {
    try {
      const { data } = await api.get(`ecos/${eco.id}/`);
      setSelectedEcoForView(data);
      setViewModalOpen(true);
    } catch (error) {
      console.error('Failed to fetch ECO details:', error);
      toast.error(t('fetch_details_fail'));
    }
  };

  const handleDownloadCSV = () => {
    const headers = [
      'eco_no', 'eco_model', 'customer', 'status', 'form_type', 
      'prepared_date', 'issued_date', 'received_date', 'applicable_date', 'due_date', 'close_date',
      'change_reason', 'change_details', 'storage_action'
    ];
    const formatDate = (dateStr: string | null) => dateStr ? new Date(dateStr).toISOString().split('T')[0] : '';

    const csvContent = [
      headers.join(','),
      ...filteredEcos.map((e: Eco) => {
        return [
          e.eco_no,
          e.eco_model,
          e.customer,
          e.status,
          e.form_type,
          formatDate(e.prepared_date),
          formatDate(e.issued_date),
          formatDate(e.received_date),
          formatDate(e.applicable_date),
          formatDate(e.due_date),
          formatDate(e.close_date),
          `"${e.change_reason || ''}"`,
          `"${e.change_details || ''}"`,
          `"${e.storage_action || ''}"`,
        ].join(',');
      })
    ].join('\n');

    const blob = new Blob(["\uFEFF" + csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.setAttribute('download', 'eco_list.csv');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target?.result as string;
      try {
        const parsedData = parseCSV(content);
        console.log('Parsed CSV data:', parsedData);
        if(parsedData.length > 0) {
          console.log('Sending bulk data:', parsedData.length, 'records');
          bulkUpload.mutate(parsedData);
        }
      } catch (error: any) {
        toast.error(error.message || t('csv_parse_fail'));
        console.error("CSV parsing error:", error);
      }
    };
    reader.readAsText(file, 'UTF-8');
    event.target.value = ''; // Reset file input
  };

  return (
    <>
      <div className="flex flex-wrap md:flex-nowrap items-center gap-2 mb-4">
        <select value={mode} onChange={e => { setKeyword(''); setMode(e.target.value as any); }} className={ctrlCls}>
          <option value="eco">{t('eco_no')}</option>
          <option value="part">PART NO.</option>
        </select>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value as any)} className={ctrlCls}>
          <option value="ALL">{t('all')}</option>
          <option value="OPEN">OPEN</option>
          <option value="CLOSED">CLOSED</option>
        </select>
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 h-4 w-4" />
          <Input
            type="text"
            placeholder={mode === 'eco' ? t('eco_search_placeholder') : t('part_search_placeholder')}
            className={"pl-10 w-full " + ctrlCls}
            value={keyword}
            onChange={(e) => { setKeyword(e.target.value); if (mode === 'part') { setSelectedPart('') } }}
          />
        </div>
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
          <Button size="sm" onClick={() => { setForm(emptyForm); setDialogOpen(true); }}>{t('new_eco')}</Button>
        </div>
      </div>
      <div className="bg-white rounded-lg shadow-lg overflow-hidden">
        {mode === 'eco' ? (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-slate-100">
                <tr>
                  <th className="px-3 py-2 text-left">{t('eco_no')}</th>
                  <th className="px-3 py-2 text-left">{t('eco_model')}</th>
                  <th className="px-3 py-2 text-left">Part No.</th>
                  <th className="px-3 py-2 text-left">{t('change_reason')}</th>
                  <th className="px-3 py-2 text-left">{t('change_details')}</th>
                  <th className="px-3 py-2 text-left">{t('status')}</th>
                  <th className="px-3 py-2 text-left"></th>
                </tr>
              </thead>
              <tbody>
                {ecosLoading ? (
                  <tr><td colSpan={7} className="text-center py-4">Loading...</td></tr>
                ) : filteredEcos.map((e: Eco) => (
                  <tr key={e.id} className={rowCls}>
                    <td className="px-3 py-1 cursor-pointer text-blue-600 underline" onClick={() => handleViewEco(e)}>{e.eco_no}</td>
                    <td className="px-3 py-1">{e.eco_model}</td>
                    <td className="px-3 py-1">{(e.details || []).map((d: { part_no: string }) => d.part_no).join(', ')}</td>
                    <td className="px-3 py-1 truncate max-w-xs">{e.change_reason}</td>
                    <td className="px-3 py-1 truncate max-w-xs">{e.change_details}</td>
                    <td className="px-3 py-1">{e.status}</td>
                    <td className="px-3 py-1 text-right flex justify-end gap-1">
                      <Button size="icon" variant="ghost" onClick={() => handleViewEco(e)} aria-label={t('view')}><Eye className="w-4 h-4" /></Button>
                      <Button size="icon" variant="ghost" onClick={async () => {
                        setErrors({});
                        try {
                          const { data } = await api.get(`ecos/${e.id}/`);
                          setForm(data);
                        } catch {
                          setForm(e);
                        }
                        setDialogOpen(true);
                      }} aria-label={t('edit')}><Pencil className="w-4 h-4" /></Button>
                      <Button size="icon" variant="ghost" onClick={() => handleDelete(e)} aria-label={t('delete')} disabled={del.isPending}><Trash2 className="w-4 h-4" /></Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <>
            {!selectedPart ? (
              <>
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead className="bg-slate-100">
                      <tr className="border-y">
                        <th className="px-3 py-2 text-left">Part No</th>
                        <th className="px-3 py-2 text-left">{t('description') || 'Description'}</th>
                        <th className="px-3 py-2 text-center">{t('eco_count')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {partCounts.map(pc => {
                        const checked = selectedParts.includes(pc.part_no);
                        return (
                          <tr key={pc.part_no} className={rowCls}>
                            <td className="px-3 py-1 font-mono flex items-center gap-2">
                              <input type="checkbox" checked={checked} onChange={() => {
                                setSelectedPart('');
                                setSelectedParts(prev => checked ? prev.filter(p => p !== pc.part_no) : [...prev, pc.part_no]);
                              }} />
                              <span className="cursor-pointer" onClick={() => setSelectedPart(pc.part_no)}>{pc.part_no}</span>
                            </td>
                            <td className="px-3 py-1 text-xs cursor-pointer hover:bg-yellow-50" onClick={() => {
                              const newDesc = prompt(`${pc.part_no} ${t('description_edit_prompt')}:`, pc.description || '');
                              if (newDesc !== null && newDesc !== pc.description) {
                                api.patch(`eco-parts/${pc.part_no}/update-description/`, { description: newDesc })
                                  .then(() => {
                                    queryClient.invalidateQueries({ queryKey: ['part-eco-count'] });
                                    toast.success(t('update_success'));
                                  })
                                  .catch(() => {
                                    toast.error(t('update_fail'));
                                  });
                              }
                            }}>{pc.description || '-'}</td>
                            <td className="px-3 py-1 text-center">{pc.count}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {selectedParts.length > 0 && (
                  <div className="mt-4">
                    <h4 className="font-semibold mb-2 pl-2">{t('selected_part_eco_details')}</h4>
                    <div className="overflow-x-auto">
                      <table className="min-w-full text-sm">
                        <thead className="bg-slate-100">
                          <tr>
                            <th className="px-3 py-2 text-center">{t('part') || 'Part'}</th>
                            <th className="px-3 py-2 text-center">{t('eco') || 'ECO'}</th>
                            <th className="px-3 py-2 text-center">{t('change_details')}</th>
                            <th className="px-3 py-2 text-center">{t('part_status') || 'Part Status'}</th>
                            <th className="px-3 py-2 text-center">{t('eco_status') || 'ECO Status'}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {selectedParts.map(partNo => {
                            const rows = ecosBySelectedParts.data?.filter((eco: Eco) => statusFilter === 'ALL' || eco.status === statusFilter).flatMap((eco: Eco) =>
                              (eco.details || []).filter((d: {part_no: string}) => d.part_no.toUpperCase() === partNo.toUpperCase()).map((d: any) => (
                                {
                                  part_no: d.part_no,
                                  eco_id: eco.id,
                                  eco_no: eco.eco_no,
                                  change_details: d.change_details,
                                  part_status: d.status,
                                  eco_status: eco.status,
                                }
                              ))
                            ) || [];
                            return rows.map((row: any, idx: number) => (
                              <tr key={`${row.part_no}-${row.eco_no}`} className={rowCls}>
                                {idx === 0 && (
                                  <td className="px-3 py-1 font-mono text-center" rowSpan={rows.length}>{row.part_no}</td>
                                )}
                                <td className="px-3 py-1 font-mono text-center cursor-pointer text-blue-600 underline" onClick={() => handleViewEco(row)}>{row.eco_no}</td>
                                <td className="px-3 py-1 text-xs text-left whitespace-pre-wrap">{row.change_details}</td>
                                <td className="px-3 py-1 text-center">{row.part_status}</td>
                                <td className="px-3 py-1 text-center">{row.eco_status}</td>
                              </tr>
                            ));
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-100">
                    <tr>
                      <th className="px-3 py-2 text-left">{t('eco')}</th>
                      <th className="px-3 py-2 text-left">{t('change_details')}</th>
                      <th className="px-3 py-2 text-left">{t('part_status')}</th>
                      <th className="px-3 py-2 text-left">{t('eco_status')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredEcos.flatMap((eco: Eco) => (eco.details || []).filter((d: {part_no: string}) => d.part_no === selectedPart).map((d: any) => (
                      <tr key={eco.id + '-' + d.id} className="border-t">
                        <td className="px-3 py-1 font-mono">{eco.eco_no}</td>
                        <td className="px-3 py-1 text-xs">{d.change_details}</td>
                        <td className="px-3 py-1">{d.status}</td>
                        <td className="px-3 py-1">{eco.status}</td>
                      </tr>
                    )))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>

      <EcoForm
        initial={form}
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSubmit={handleUpsert}
        isSaving={upsert.isPending}
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