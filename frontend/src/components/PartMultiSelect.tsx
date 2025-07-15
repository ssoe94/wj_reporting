import { useState } from 'react';
import { usePartSearch } from '@/hooks/usePartSearch';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import type { PartSpec } from '@/hooks/usePartSpecs';
import { useLang } from '@/i18n';

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
    const manual: PartSpec = { id: Date.now()*-1, part_no: kw, model_code:'', description:'' } as PartSpec;
    onAdd([manual]);
    setKeyword('');
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
              <button type="button" className="text-blue-600 underline" onClick={addManual}>“{keyword.trim()}” 직접 추가</button>
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