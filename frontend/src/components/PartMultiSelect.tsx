import { useState } from 'react';
import { usePartSearch } from '@/hooks/usePartSearch';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import type { PartSpec } from '@/hooks/usePartSpecs';
import { useLang } from '@/i18n';
import api from '@/lib/api';

interface Props {
  onAdd: (parts: PartSpec[]) => void;
}

export default function PartMultiSelect({ onAdd }: Props) {
  const { t } = useLang();
  const [keyword, setKeyword] = useState('');
  const [selected, setSelected] = useState<PartSpec[]>([]);
  const { data: results = [] } = usePartSearch(keyword);
  const addManual = () => {
    const kw = keyword.trim();
    if(!kw) return;
    
    // description 입력받기
    const description = prompt(`${kw}의 Description을 입력하세요:`, '');
    if (description === null) return; // 취소된 경우
    
    // API를 통해 Part 생성 또는 업데이트
    api.post('parts/create-or-update/', {
      part_no: kw,
      description: description || ''
    }).then(({ data }) => {
      const manual: PartSpec = { 
        id: data.id, 
        part_no: data.part_no, 
        model_code: data.model_code || '', 
        description: data.description || '' 
      } as PartSpec;
      onAdd([manual]);
      setKeyword('');
    }).catch(() => {
      // API 실패 시 임시 ID로 추가 (나중에 저장 시 처리)
      const manual: PartSpec = { 
        id: Date.now()*-1, 
        part_no: kw, 
        model_code: '', 
        description: description || '' 
      } as PartSpec;
      onAdd([manual]);
      setKeyword('');
    });
  };

  const toggle = (p: PartSpec) => {
    setSelected(prev=> prev.some(it=>it.id===p.id) ? prev.filter(it=>it.id!==p.id) : [...prev, p]);
  };

  return (
    <div className="border rounded p-3 space-y-2">
      <div className="flex gap-2 items-center">
        <Input value={keyword} onChange={(e)=>setKeyword(e.target.value)} placeholder={t('search_placeholder')} className="flex-1" />
        <Button size="sm" onClick={()=>{onAdd(selected); setSelected([]); setKeyword('');}} disabled={!selected.length}>{t('select')}</Button>
      </div>
      {keyword.trim() && (
        <ul className="max-h-60 overflow-auto border rounded p-2 text-sm space-y-1 bg-white">
          {results.map(r=> (
            <li key={r.id} className="flex items-center gap-2">
              <input type="checkbox" checked={selected.some(it=>it.id===r.id)} onChange={()=>toggle(r)} />
              <span className="font-mono">{r.part_no}</span>
              <span className="text-gray-500 text-xs">{r.description}</span>
            </li>
          ))}
          {!results.length && (
            <li className="text-center text-xs py-4">
              <button type="button" className="text-blue-600 underline" onClick={addManual}>“{keyword.trim()}” {t('add_directly')}</button>
            </li>
          )}
        </ul>
      )}
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1 text-xs">
          {selected.map(p=> (
            <span key={p.id} className="border rounded px-1 py-0.5 bg-orange-50 text-gray-700 font-mono">
              {p.part_no}
            </span>
          ))}
        </div>
      )}
    </div>
  );
} 