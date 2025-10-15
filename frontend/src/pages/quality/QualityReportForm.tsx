import { FileText, PlusCircle, Plus, X, Loader2 } from 'lucide-react';
import { useLang } from '../../i18n';
import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Label } from '../../components/ui/label';
import { Input } from '../../components/ui/input';
import { Textarea } from '../../components/ui/textarea';
import PermissionButton from '../../components/common/PermissionButton';
import { toast } from 'react-toastify';
import { Autocomplete, TextField } from '@mui/material';
import DateTimeField from '../../components/DateTimeField';

import type { PartSpec } from '../../hooks/usePartSpecs';
import { usePartSpecSearch, usePartListByModel } from '../../hooks/usePartSpecs';
import { useAssemblyPartsByModel, useAssemblyPartspecsByModel, useAssemblyPartNoSearch, useAssemblyModelSearch } from '../../hooks/useAssemblyParts';
import { useQueryClient } from '@tanstack/react-query';
import api from '../../lib/api';
import machines from '../../constants/machines';
import { uploadToCloudinary } from '../../utils/cloudinaryUpload';

export default function QualityReportForm() {
  const { t, lang } = useLang();
  const queryClient = useQueryClient();
  
  // 현재 시간을 YYYY-MM-DDTHH:mm 형식으로 가져오기
  const getCurrentDateTime = () => {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day}T${hours}:${minutes}`;
  };
  
  const [form, setForm] = useState({
    report_dt: getCurrentDateTime(), // 현재 시간으로 자동 설정
    section: 'LQC_INJ',
    machineId: '',
    productionLine: '',
    supplier: '',
    productionDate: '',
    model: '',
    part_no: '',
    phenomenon: '',
    inspection_qty: '',
    defect_qty: '',
    defect_rate: '',
    lot_qty: '',
    judgement: 'NG',
    disposition: '',
  });

  // 이미지 파일 상태 (최대 3장)
  const [imageFiles, setImageFiles] = useState<(File | null)[]>([null, null, null]);
  const [imagePreviews, setImagePreviews] = useState<(string | null)[]>([null, null, null]);
  const [imageUrls, setImageUrls] = useState<(string | null)[]>([null, null, null]); // Cloudinary URLs
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);

  // 공급자 목록 (IQC용) - DB에서 불러오기
  const [suppliers, setSuppliers] = useState<string[]>([]);

  // 공급자 목록 불러오기
  useEffect(() => {
    const fetchSuppliers = async () => {
      try {
        const { data } = await api.get('/quality/suppliers/');
        // API가 페이지네이션을 사용하는 경우 results 배열 사용
        const suppliers = Array.isArray(data) ? data : (data.results || []);
        setSuppliers(suppliers.map((s: any) => s.name));
      } catch (err) {
        console.error('Failed to fetch suppliers:', err);
      }
    };
    fetchSuppliers();
  }, []);

  // 모델/Part 선택
  const [productQuery, setProductQuery] = useState('');
  const [selectedModelDesc, setSelectedModelDesc] = useState<PartSpec | null>(null);
  const [selectedPartSpec, setSelectedPartSpec] = useState<PartSpec | null>(null);
  const [showAddPartModal, setShowAddPartModal] = useState(false);
  const [newPartForm, setNewPartForm] = useState<any>({
    part_no: '',
    model_code: '',
    description: '',
  });
  const [prefillOriginal, setPrefillOriginal] = useState<any | null>(null);

  const { data: searchResults = [] } = usePartSpecSearch(productQuery.toUpperCase());
  const { data: modelParts = [] } = usePartListByModel(selectedModelDesc?.model_code);
  const { data: asmPartsByModel = [] } = useAssemblyPartsByModel(selectedModelDesc?.model_code);
  const { data: asmPartspecsByModel = [] } = useAssemblyPartspecsByModel(selectedModelDesc?.model_code);
  const { data: asmPartNoSearch = [] } = useAssemblyPartNoSearch(productQuery || '');
  const { data: asmModelSearch = [] } = useAssemblyModelSearch(productQuery || '');

  const uniqueModelDesc = ((): PartSpec[] => {
    const map = new Map<string, PartSpec>();
    searchResults.forEach((it: any) => {
      const key = `${it.model_code}|${it.description || ''}`;
      if (!map.has(key)) map.set(key, it);
    });
    (Array.isArray(asmModelSearch) ? asmModelSearch as any[] : []).forEach((it: any) => {
      const modelCode = it.model || it.model_code;
      if (!modelCode) return;
      const desc = it.description || '';
      const key = `${modelCode}|${desc}`;
      if (!map.has(key)) map.set(key, { model_code: modelCode, description: desc, id: 0, part_no: '' } as any);
    });
    if (selectedModelDesc?.model_code) {
      const key = `${selectedModelDesc.model_code}|${selectedModelDesc.description || ''}`;
      if (!map.has(key)) map.set(key, selectedModelDesc as any);
    }
    return Array.from(map.values());
  })();

  const handleChange = (k: string, v: any) => setForm(prev => ({ ...prev, [k]: v }));

  // 이미지 리사이징 함수
  const resizeImage = (file: File): Promise<File> => {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          const maxSize = 1024;
          let width = img.width;
          let height = img.height;

          // 긴 변이 1024px을 초과하는 경우에만 리사이징
          if (width > maxSize || height > maxSize) {
            if (width > height) {
              height = (height * maxSize) / width;
              width = maxSize;
            } else {
              width = (width * maxSize) / height;
              height = maxSize;
            }
          }

          // Canvas로 리사이징
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx?.drawImage(img, 0, 0, width, height);

          // Canvas를 Blob으로 변환
          canvas.toBlob(
            (blob) => {
              if (blob) {
                const resizedFile = new File([blob], file.name, {
                  type: file.type,
                  lastModified: Date.now(),
                });
                resolve(resizedFile);
              } else {
                resolve(file);
              }
            },
            file.type,
            0.9 // JPEG 품질 90%
          );
        };
        img.src = e.target?.result as string;
      };
      reader.readAsDataURL(file);
    });
  };

  // 다중 이미지 선택 핸들러 (추가하기 버튼)
  const handleMultipleImageChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []).filter(file => file.type.startsWith('image/'));
    
    if (files.length === 0) return;

    // 현재 비어있는 슬롯 찾기
    const emptySlots: number[] = [];
    imageFiles.forEach((file, idx) => {
      if (!file) emptySlots.push(idx);
    });

    if (emptySlots.length === 0) {
      toast.warning(t('quality.image_max_warning'));
      return;
    }

    // 최대 3장까지만 처리
    const filesToAdd = files.slice(0, Math.min(files.length, emptySlots.length));
    
    if (files.length > emptySlots.length) {
      toast.warning(t('quality.image_max_warning'));
    }

    // 모든 파일을 먼저 리사이징
    const resizedFiles = await Promise.all(filesToAdd.map(file => resizeImage(file)));
    
    // 새로운 배열 생성
    const newFiles = [...imageFiles];
    const newPreviews = [...imagePreviews];
    
    // 각 파일 처리
    for (let i = 0; i < resizedFiles.length; i++) {
      const resizedFile = resizedFiles[i];
      const slotIndex = emptySlots[i];
      
      newFiles[slotIndex] = resizedFile;
      
      // 미리보기 생성
      const reader = new FileReader();
      reader.onloadend = () => {
        setImagePreviews(prev => {
          const updated = [...prev];
          updated[slotIndex] = reader.result as string;
          return updated;
        });
      };
      reader.readAsDataURL(resizedFile);
    }
    
    setImageFiles(newFiles);
    
    // input 초기화
    e.target.value = '';
  };

  // 이미지 제거 핸들러
  const handleImageRemove = (index: number) => {
    const newFiles = [...imageFiles];
    newFiles[index] = null;
    setImageFiles(newFiles);
    
    const newPreviews = [...imagePreviews];
    newPreviews[index] = null;
    setImagePreviews(newPreviews);
  };

  // 드래그 앤 드롭 핸들러
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files).filter(file => file.type.startsWith('image/'));
    
    if (files.length === 0) return;

    // 현재 비어있는 슬롯 찾기
    const emptySlots: number[] = [];
    imageFiles.forEach((file, idx) => {
      if (!file) emptySlots.push(idx);
    });

    if (emptySlots.length === 0) {
      toast.warning(t('quality.image_max_warning'));
      return;
    }

    // 최대 3장까지만 처리
    const filesToAdd = files.slice(0, Math.min(files.length, emptySlots.length));
    
    if (files.length > emptySlots.length) {
      toast.warning(t('quality.image_max_warning'));
    }

    // 모든 파일을 먼저 리사이징
    const resizedFiles = await Promise.all(filesToAdd.map(file => resizeImage(file)));
    
    // 새로운 배열 생성
    const newFiles = [...imageFiles];
    const newPreviews = [...imagePreviews];
    
    // 각 파일 처리
    for (let i = 0; i < resizedFiles.length; i++) {
      const resizedFile = resizedFiles[i];
      const slotIndex = emptySlots[i];
      
      newFiles[slotIndex] = resizedFile;
      
      // 미리보기 생성
      const reader = new FileReader();
      reader.onloadend = () => {
        setImagePreviews(prev => {
          const updated = [...prev];
          updated[slotIndex] = reader.result as string;
          return updated;
        });
      };
      reader.readAsDataURL(resizedFile);
    }
    
    setImageFiles(newFiles);
  };

  // 공급자 추가 시 DB에 저장
  const addSupplier = async (supplierName: string) => {
    if (supplierName && !suppliers.includes(supplierName)) {
      try {
        await api.post('/quality/suppliers/get_or_create/', { name: supplierName });
        setSuppliers(prev => [...prev, supplierName].sort());
      } catch (err) {
        console.error('Failed to add supplier:', err);
      }
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    // 보고일시가 비어있으면 현재 시간으로 자동 설정
    if (!form.report_dt) {
      setForm(prev => ({ ...prev, report_dt: getCurrentDateTime() }));
    }
    
    if (!form.model || !form.part_no) {
      toast.error(t('quality.model_part_no_required'));
      return;
    }

    (async () => {
      setIsUploading(true);
      try {
        // IQC인 경우 공급자 저장
        if (form.section === 'IQC' && form.supplier) {
          await addSupplier(form.supplier);
        }

        // 1. 이미지를 Cloudinary에 업로드
        const uploadedUrls: (string | null)[] = [null, null, null];
        for (let i = 0; i < imageFiles.length; i++) {
          if (imageFiles[i]) {
            try {
              toast.info(`이미지 ${i + 1} 업로드 중...`);
              const result = await uploadToCloudinary(imageFiles[i]!, 'quality');
              uploadedUrls[i] = result.secure_url;
              console.log(`Image ${i + 1} uploaded:`, result.secure_url);
            } catch (uploadError) {
              console.error(`Image ${i + 1} upload failed:`, uploadError);
              toast.error(`이미지 ${i + 1} 업로드 실패`);
            }
          }
        }

        // 2. 불량률 계산
        const insp = Number(form.inspection_qty) || 0;
        const defect = Number(form.defect_qty) || 0;
        const rate = insp > 0 ? Math.round((defect / insp) * 10000) / 100 : 0;
        
        // 3. JSON 데이터로 전송 (Cloudinary URL 포함)
        const reportData = {
          report_dt: form.report_dt,
          section: form.section,
          model: form.model,
          part_no: form.part_no,
          lot_qty: form.lot_qty ? Number(form.lot_qty) : null,
          inspection_qty: form.inspection_qty ? Number(form.inspection_qty) : null,
          defect_qty: form.defect_qty ? Number(form.defect_qty) : null,
          defect_rate: `${rate}%`,
          judgement: form.judgement || 'NG',
          phenomenon: form.phenomenon || '',
          disposition: form.disposition || '',
          image1: uploadedUrls[0] || null,
          image2: uploadedUrls[1] || null,
          image3: uploadedUrls[2] || null,
        };
        
        console.log('📤 Sending report data:', reportData);

        await api.post('/quality/reports/', reportData);
        toast.success(t('save_success'));
        queryClient.invalidateQueries({ queryKey: ['quality-reports'] });
        
        // 폼 초기화 (보고일시는 현재 시간으로 재설정)
        setForm({
          report_dt: getCurrentDateTime(),
          section: form.section,
          machineId: '',
          productionLine: '',
          supplier: '',
          productionDate: '',
          model: '',
          part_no: '',
          phenomenon: '',
          inspection_qty: '',
          defect_qty: '',
          defect_rate: '',
          lot_qty: '',
          judgement: 'NG',
          disposition: '',
        });
        setSelectedModelDesc(null);
        setSelectedPartSpec(null);
        setImageFiles([null, null, null]);
        setImagePreviews([null, null, null]);
        setImageUrls([null, null, null]);
      } catch (err: any) {
        console.error('Save error:', err);
        toast.error(t('save_fail'));
      } finally {
        setIsUploading(false);
      }
    })();
  };

  // 동적 필드 렌더링 (애니메이션 포함)
  const renderDynamicField = () => {
    const fieldVariants = {
      initial: { opacity: 0, rotateX: -90, scale: 0.8 },
      animate: { opacity: 1, rotateX: 0, scale: 1, transition: { duration: 0.4, ease: 'easeOut' } },
      exit: { opacity: 0, rotateX: 90, scale: 0.8, transition: { duration: 0.3 } }
    };

    let fieldContent = null;
    let fieldKey = form.section;

    switch (form.section) {
      case 'LQC_INJ':
        fieldContent = (
          <div>
            <Label htmlFor="machineId">{t('machine')}</Label>
            <select
              id="machineId"
              value={form.machineId}
              onChange={(e) => handleChange('machineId', e.target.value)}
              className="block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-700 focus:border-blue-500 focus:ring-blue-500"
            >
              <option value="">{t('quality.select_machine')}</option>
              {machines.map((m) => (
                <option key={m.id} value={m.id}>
                  {t('quality.machine_option', { id: m.id, ton: m.ton })}
                </option>
              ))}
            </select>
          </div>
        );
        break;
      
      case 'LQC_ASM':
        fieldContent = (
          <div>
            <Label htmlFor="productionLine">{t('quality.production_line')}</Label>
            <select
              id="productionLine"
              value={form.productionLine}
              onChange={(e) => handleChange('productionLine', e.target.value)}
              className="block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-700 focus:border-blue-500 focus:ring-blue-500"
            >
              <option value="">{t('quality.select_line')}</option>
              <option value="A">A Line</option>
              <option value="B">B Line</option>
              <option value="C">C Line</option>
              <option value="D">D Line</option>
            </select>
          </div>
        );
        break;
      
      case 'IQC':
        fieldContent = (
          <div>
            <Label htmlFor="supplier">{t('quality.supplier')}</Label>
            <Autocomplete
              freeSolo
              options={suppliers}
              value={form.supplier}
              onInputChange={(_, newValue) => handleChange('supplier', newValue)}
              renderInput={(params) => (
                <TextField
                  {...params}
                  size="small"
                  placeholder={t('quality.supplier_placeholder')}
                />
              )}
            />
          </div>
        );
        break;
      
      case 'OQC':
      case 'CS':
        fieldContent = (
          <div>
            <Label htmlFor="productionDate">{t('quality.production_date')}</Label>
            <Input
              id="productionDate"
              type="date"
              value={form.productionDate}
              onChange={(e) => handleChange('productionDate', e.target.value)}
            />
          </div>
        );
        break;
      
      default:
        return null;
    }

    return (
      <AnimatePresence mode="wait">
        <motion.div
          key={fieldKey}
          variants={fieldVariants}
          initial="initial"
          animate="animate"
          exit="exit"
          style={{ transformStyle: 'preserve-3d' }}
        >
          {fieldContent}
        </motion.div>
      </AnimatePresence>
    );
  };

  return (
    <>
      <div className="rounded-lg border border-gray-200 bg-white shadow-sm">
        <div className="flex items-center gap-2 border-b border-gray-200 px-4 py-3 bg-gradient-to-r from-blue-50 to-white">
          <FileText className="w-5 h-5 text-blue-600" />
          <h2 className="text-base font-semibold text-gray-800">{t('nav_quality_report')}</h2>
        </div>
        
        <form onSubmit={handleSubmit} className="px-4 pt-6 pb-6 space-y-6">
          {/* 첫 번째 행: 보고일시/보고부문/동적필드/모델/PART NO. */}
          <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
            <div>
              <Label htmlFor="report_dt">{t('quality.report_datetime')}</Label>
              <DateTimeField
                value={form.report_dt || ''}
                onChange={(v) => handleChange('report_dt', v)}
                locale={lang === 'zh' ? 'zh' : 'ko'}
                minuteStep={5}
              />
            </div>
            
            <div>
              <Label htmlFor="section">{t('quality.section')}</Label>
              <select
                id="section"
                value={form.section}
                onChange={(e) => handleChange('section', e.target.value)}
                className="block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-700 focus:border-blue-500 focus:ring-blue-500"
              >
                <option value="LQC_INJ">LQC - {t('quality.section_injection')}</option>
                <option value="LQC_ASM">LQC - {t('quality.section_assembly')}</option>
                <option value="IQC">IQC</option>
                <option value="OQC">OQC</option>
                <option value="CS">CS</option>
              </select>
            </div>

            {/* 동적 필드 */}
            {renderDynamicField()}

            <div>
              <Label>{t('model')}</Label>
              <Autocomplete<PartSpec | { isAddModel: true; model_code: string; description?: string }>
                options={uniqueModelDesc}
                openOnFocus
                includeInputInList
                getOptionLabel={(opt) => opt.description ? `${opt.model_code} – ${opt.description}` : `${opt.model_code}`}
                isOptionEqualToValue={(a, b) => (a?.model_code === b?.model_code) && ((a?.description || '') === (b?.description || ''))}
                onInputChange={(_, v) => setProductQuery(v)}
                value={selectedModelDesc}
                onChange={(_, v) => {
                  setSelectedModelDesc(v as PartSpec | null);
                  if (v && 'model_code' in v) {
                    setForm((f) => ({ ...f, model: v.model_code, part_no: '' }));
                    setSelectedPartSpec(null);
                  }
                }}
                filterOptions={(opts, state) => {
                  const input = (state.inputValue || '').trim().toUpperCase();
                  let filtered = !input ? opts : opts.filter(o => String((o as any).model_code || '').toUpperCase().includes(input)
                    || String(o.description || '').toUpperCase().includes(input));
                  if (input && filtered.length === 0) {
                    filtered = [{ isAddModel: true, model_code: state.inputValue }] as any;
                  }
                  return filtered as any;
                }}
                renderInput={(params) => <TextField {...params} size="small" placeholder={t('model_search')} />}
                renderOption={(props, option) => {
                  const { key, ...rest } = props as any;
                  if ((option as any).isAddModel) {
                    return (
                      <li key={key} {...rest} className="bg-green-50 hover:bg-green-100 border-t border-green-200">
                        <div className="flex items-center justify-center gap-2 text-green-700 font-medium py-2 text-sm">
                          <Plus className="h-3 w-3" />
                          <span>"{(option as any).model_code}" {t('add_new_part_prompt')}</span>
                        </div>
                      </li>
                    );
                  }
                  const spec = option as PartSpec;
                  return (
                    <li key={key} {...rest}>
                      <div className="flex flex-col">
                        <span className="font-mono font-medium">{spec.model_code}</span>
                        {spec.description && <span className="text-sm text-gray-600">{spec.description}</span>}
                      </div>
                    </li>
                  );
                }}
              />
            </div>

            <div>
              <Label>{t('part_no')}</Label>
              <Autocomplete<PartSpec | { isAddNew: boolean; part_no: string } | { isAddNewForModel: boolean }>
                options={(() => {
                  const baseOptions = selectedModelDesc
                    ? ((asmPartspecsByModel as any).length ? (asmPartspecsByModel as any) : ((asmPartsByModel as any).length ? (asmPartsByModel as any) : modelParts))
                    : (() => {
                      const asmOptions = Array.isArray(asmPartNoSearch)
                        ? (asmPartNoSearch as any[]).map((r: any) => ({ part_no: r.part_no, model_code: (r as any).model || (r as any).model_code || '', description: r.description || '' }))
                        : [];
                      const merged = [...asmOptions, ...searchResults];
                      const seen = new Set<string>();
                      return merged.filter((o: any) => {
                        const key = String(o.part_no || '');
                        if (seen.has(key)) return false;
                        seen.add(key);
                        return true;
                      });
                    })();
                  if (productQuery.trim().length >= 2 && baseOptions.length === 0) return [{ isAddNew: true, part_no: productQuery.trim() } as any];
                  if (selectedModelDesc && baseOptions.length === 0) return [{ isAddNewForModel: true } as any];
                  return baseOptions;
                })()}
                openOnFocus
                renderOption={(props, option) => {
                  const { key, ...rest } = props as any;
                  if ('isAddNew' in option && (option as any).isAddNew) {
                    return (
                      <li key={key} {...rest} className="bg-green-50 hover:bg-green-100 border-t border-green-200">
                        <div className="flex items-center justify-center gap-2 text-green-700 font-medium py-2 text-sm">
                          <Plus className="h-3 w-3" />
                          <span>"{(option as any).part_no}" {t('add_new_part_prompt')}</span>
                        </div>
                      </li>
                    );
                  }
                  const spec = option as PartSpec;
                  return (
                    <li key={key} {...rest}>
                      <div className="flex flex-col">
                        <span className="font-mono font-medium">{spec.part_no}</span>
                        {spec.model_code && <span className="text-sm text-gray-600">{spec.model_code} - {spec.description}</span>}
                      </div>
                    </li>
                  );
                }}
                filterOptions={(opts, state) => {
                  let filtered: any[] = opts.slice();
                  if (selectedModelDesc) {
                    filtered = filtered.filter((o: any) => {
                      if (('isAddNew' in o) || ('isAddNewForModel' in o)) return true;
                      const modelOk = o.model_code === selectedModelDesc.model_code;
                      const descOk = !selectedModelDesc.description || !o.description || o.description === selectedModelDesc.description;
                      return modelOk && descOk;
                    });
                  }
                  const input = (state.inputValue || '').trim().toUpperCase();
                  if (input) filtered = filtered.filter((o: any) => ('isAddNew' in o) || ('isAddNewForModel' in o) ? true : String(o.part_no || '').toUpperCase().includes(input));
                  if (filtered.length === 0 && input) return [{ isAddNew: true, part_no: input } as any];
                  return filtered;
                }}
                getOptionLabel={(opt) => {
                  if ('isAddNew' in opt && (opt as any).isAddNew) return (opt as any).part_no || '';
                  if ('isAddNewForModel' in opt && (opt as any).isAddNewForModel) return productQuery.trim();
                  return String((opt as any).part_no || '');
                }}
                onInputChange={(_, v) => setProductQuery(v)}
                onChange={async (_, v) => {
                  if (v && ('isAddNew' in v || 'isAddNewForModel' in v)) {
                    const desired = (productQuery || '').trim();
                    let prefillData: any = null;
                    try {
                      const norm = desired.replace(/\s+/g, '').toUpperCase();
                      const prefix9 = norm.slice(0, 9);
                      let list: any[] = [];
                      if (prefix9.length === 9) {
                        const { data } = await api.get('/assembly/products/search-parts/', { params: { search: prefix9, prefix_only: 1 } });
                        let all = Array.isArray(data) ? data : [];
                        list = all.filter((it: any) => String(it.part_no || '').toUpperCase().startsWith(prefix9));
                        if (selectedModelDesc) list = list.filter((it: any) => it.model === selectedModelDesc.model_code);
                      }

                      if (list.length > 0) {
                        const top = list[0];
                        const ok = window.confirm(t('similar_parts_prompt').replace('{first}', top.part_no).replace('{count}', String(list.length)));
                        if (ok) {
                          prefillData = {
                            model_code: top.model,
                            description: top.description,
                          } as any;
                        }
                      }
                    } catch (_) { }
                    setNewPartForm((prev: any) => ({
                      ...prev,
                      part_no: desired,
                      model_code: (prefillData as any)?.model_code || selectedModelDesc?.model_code || '',
                      description: (prefillData as any)?.description || selectedModelDesc?.description || '',
                    }));
                    setPrefillOriginal({
                      part_no: desired,
                      model_code: (prefillData as any)?.model_code || selectedModelDesc?.model_code || '',
                      description: (prefillData as any)?.description || selectedModelDesc?.description || '',
                    });
                    setShowAddPartModal(true);
                    return;
                  }
                  setSelectedPartSpec(v as PartSpec);
                  if (v && !('isAddNew' in v)) {
                    const modelCode = (v as any).model_code || (v as any).model || '';
                    setForm((f) => ({ ...f, part_no: (v as any).part_no, model: modelCode }));
                    const modelSpec = uniqueModelDesc.find((m) => m.model_code === modelCode && m.description === (v as any).description);
                    if (modelSpec) setSelectedModelDesc(modelSpec);
                    else if (modelCode) setSelectedModelDesc({ model_code: modelCode, description: (v as any).description || '' } as any);
                  }
                }}
                value={selectedPartSpec}
                renderInput={(params) => <TextField {...params} size="small" placeholder={t('quality.part_no_input_or_select')} />}
              />
            </div>
          </div>

          {/* 두 번째 행: LOT SIZE/검사수/불량수/불량률/판정결과 */}
          {(() => {
            const insp = Number(form.inspection_qty) || 0;
            const defect = Number(form.defect_qty) || 0;
            const rate = insp > 0 ? Math.round((defect / insp) * 10000) / 100 : 0;
            return (
              <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
                <div>
                  <Label htmlFor="lot_qty">{t('quality.lot_size')}</Label>
                  <Input id="lot_qty" value={form.lot_qty} onChange={(e) => handleChange('lot_qty', e.target.value)} placeholder="400" />
                </div>
                <div>
                  <Label htmlFor="inspection_qty">{t('quality.inspection_qty')}</Label>
                  <Input id="inspection_qty" type="number" inputMode="numeric" min={0} value={form.inspection_qty} onChange={(e) => handleChange('inspection_qty', e.target.value)} placeholder={t('quality.inspection_qty_placeholder')} />
                </div>
                <div>
                  <Label htmlFor="defect_qty">{t('quality.defect_qty')}</Label>
                  <Input id="defect_qty" type="number" inputMode="numeric" min={0} value={form.defect_qty} onChange={(e) => handleChange('defect_qty', e.target.value)} placeholder={t('quality.defect_qty_placeholder')} />
                </div>
                <div>
                  <Label htmlFor="defect_rate">{t('quality.defect_rate')}</Label>
                  <Input id="defect_rate" value={insp === 0 && defect === 0 ? '' : `${rate}%`} disabled className="bg-gray-100" />
                </div>
                <div>
                  <Label htmlFor="judgement">{t('quality.judgement')}</Label>
                  <select
                    id="judgement"
                    value={form.judgement}
                    onChange={(e) => handleChange('judgement', e.target.value)}
                    className="block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-700 focus:border-blue-500 focus:ring-blue-500"
                  >
                    <option value="OK">OK</option>
                    <option value="NG">NG</option>
                  </select>
                </div>
              </div>
            );
          })()}

          {/* 세 번째 행: 불량 현상 / 처리 방식 */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="phenomenon">{t('quality.defect_phenomenon')}</Label>
              <Textarea 
                id="phenomenon" 
                rows={3} 
                value={form.phenomenon} 
                onChange={(e) => handleChange('phenomenon', e.target.value)}
                placeholder={t('quality.phenomenon_placeholder')}
              />
            </div>
            <div>
              <Label htmlFor="disposition">{t('quality.disposition')}</Label>
              <Textarea id="disposition" rows={3} value={form.disposition} onChange={(e) => handleChange('disposition', e.target.value)} placeholder={t('quality.disposition_placeholder')} />
            </div>
          </div>

          {/* 네 번째 행: 이미지 업로드 (최대 3장) */}
          <div>
            <div className="flex items-center gap-3 mb-3">
              <Label>{t('quality.image_upload')}</Label>
              <label className="cursor-pointer inline-flex items-center gap-2 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors text-sm">
                <Plus className="w-4 h-4" />
                <span>{t('quality.image_add')}</span>
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={handleMultipleImageChange}
                  className="hidden"
                />
              </label>
              <span className="text-xs text-gray-500">{t('quality.image_max_info')}</span>
            </div>
            
            {/* 드래그 앤 드롭 영역 */}
            <div
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              className={`border-2 border-dashed rounded-lg p-6 transition-all ${
                isDragging
                  ? 'border-blue-500 bg-blue-50'
                  : 'border-gray-300 bg-gray-50'
              }`}
            >
              {imageFiles.some(f => f !== null) ? (
                /* 이미지 미리보기 그리드 */
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {[0, 1, 2].map((index) => (
                    imagePreviews[index] && (
                      <div key={index} className="relative group">
                        <img
                          src={imagePreviews[index]!}
                          alt={`Preview ${index + 1}`}
                          className="w-full h-40 rounded-lg border border-gray-300 object-cover"
                        />
                        <button
                          type="button"
                          onClick={() => handleImageRemove(index)}
                          className="absolute top-2 right-2 bg-red-600 hover:bg-red-700 text-white rounded-full p-1.5 opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          <X className="w-4 h-4" />
                        </button>
                        <div className="absolute bottom-2 left-2 bg-black/60 text-white text-xs px-2 py-1 rounded">
                          {index + 1}
                        </div>
                      </div>
                    )
                  ))}
                </div>
              ) : (
                /* 빈 상태 */
                <div className="text-center py-8">
                  <FileText className="w-12 h-12 mx-auto mb-3 text-gray-400" />
                  <p className="text-sm text-gray-600 mb-1">{t('quality.image_drag_drop')}</p>
                  <p className="text-xs text-gray-400">{t('quality.image_max_info')}</p>
                </div>
              )}
            </div>
          </div>

          {/* 저장 버튼 */}
          <div className="flex justify-end">
            <PermissionButton
              permission="can_edit_quality"
              type="submit"
              disabled={isUploading}
              className="px-6 py-3 bg-blue-600 text-white hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed rounded-lg font-medium transition-all duration-200 inline-flex items-center gap-2 whitespace-nowrap"
            >
              {isUploading ? (
                <>
                  <Loader2 className="h-5 w-5 shrink-0 animate-spin" />
                  {t('saving')}
                </>
              ) : (
                <>
                  <PlusCircle className="h-5 w-5 shrink-0" />
                  {t('save')}
                </>
              )}
            </PermissionButton>
          </div>
        </form>
      </div>

      {/* Add Part Modal */}
      {showAddPartModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg w-[420px] p-6 space-y-4">
            <h3 className="text-lg font-semibold mb-2">{t('add_new_part_spec')}</h3>
            <p className="text-xs text-gray-500">{t('quality.add_part_required_fields')}</p>
            <div className="grid grid-cols-2 gap-3">
              <input placeholder={t('part_no')} className="border rounded px-2 py-1 col-span-2 bg-green-50 border-green-300" value={newPartForm.part_no} onChange={(e) => setNewPartForm((f: any) => ({ ...f, part_no: e.target.value }))} />
              <input placeholder={t('quality.model_code')} className={`border rounded px-2 py-1 col-span-2${prefillOriginal?.model_code ? ' bg-yellow-50 border-yellow-300' : ''}`} value={newPartForm.model_code} onChange={(e) => setNewPartForm((f: any) => ({ ...f, model_code: e.target.value }))} />
              <input placeholder={t('description')} className={`border rounded px-2 py-1 col-span-2${prefillOriginal?.description ? ' bg-yellow-50 border-yellow-300' : ''}`} value={newPartForm.description} onChange={(e) => setNewPartForm((f: any) => ({ ...f, description: e.target.value }))} />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button className="px-3 py-1 text-sm" onClick={() => setShowAddPartModal(false)}>{t('cancel')}</button>
              <button className="px-3 py-1 bg-blue-600 text-white text-sm rounded" onClick={async () => {
                try {
                  const partNo = String(newPartForm.part_no || '').trim();
                  const modelCode = String(newPartForm.model_code || '').trim();
                  const description = String(newPartForm.description || '').trim();
                  if (!partNo || !modelCode || !description) {
                    toast.error(t('quality.part_model_desc_required'));
                    return;
                  }
                  const newPart = await api.post('/assembly/partspecs/create-or-update/', { part_no: partNo, model_code: modelCode, description });
                  toast.success(t('new_part_added_success'));
                  queryClient.invalidateQueries({ queryKey: ['assembly-partspecs'] });
                  queryClient.invalidateQueries({ queryKey: ['assembly-partspecs-by-model'] });
                  queryClient.invalidateQueries({ queryKey: ['assembly-partno-search'] });
                  queryClient.invalidateQueries({ queryKey: ['parts-search'] });
                  queryClient.invalidateQueries({ queryKey: ['parts-model'] });
                  queryClient.invalidateQueries({ queryKey: ['parts-all'] });
                  setShowAddPartModal(false);
                  const createdPart = newPart.data || {};
                  const createdModelCode = createdPart.model_code || modelCode;
                  setProductQuery(createdModelCode);
                  setForm((f) => ({ ...f, part_no: createdPart.part_no || partNo, model: createdModelCode }));
                } catch (err: any) {
                  toast.error(t('save_fail'));
                }
              }}>{t('save')}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
