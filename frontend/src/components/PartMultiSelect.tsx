import { useState } from 'react';
import { usePartSearch } from '@/hooks/usePartSearch';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
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
  const [modalOpen, setModalOpen] = useState(false);
  const [modalPartNo, setModalPartNo] = useState('');
  const [modalDescription, setModalDescription] = useState('');
  const { data: results = [] } = usePartSearch(keyword);
  
  const addManual = () => {
    const kw = keyword.trim();
    if(!kw) return;
    setModalPartNo(kw);
    setModalDescription('');
    setModalOpen(true);
  };

  const handleModalSubmit = () => {
    const partNo = modalPartNo.trim();
    if(!partNo) return;
    
    // API를 통해 Part 생성 또는 업데이트
    api.post('parts/create-or-update/', {
      part_no: partNo,
      description: modalDescription || ''
    }).then(({ data }) => {
      const manual: PartSpec = { 
        id: data.id, 
        part_no: data.part_no, 
        model_code: data.model_code || '', 
        description: data.description || '' 
      } as PartSpec;
      onAdd([manual]);
      setKeyword('');
      setModalOpen(false);
    }).catch(() => {
      // API 실패 시 임시 ID로 추가 (나중에 저장 시 처리)
      const manual: PartSpec = { 
        id: Date.now()*-1, 
        part_no: partNo, 
        model_code: '', 
        description: modalDescription || '' 
      } as PartSpec;
      onAdd([manual]);
      setKeyword('');
      setModalOpen(false);
    });
  };

  const toggle = (p: PartSpec) => {
    setSelected(prev=> prev.some(it=>it.id===p.id) ? prev.filter(it=>it.id!==p.id) : [...prev, p]);
  };

  return (
    <>
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
                <button type="button" className="text-blue-600 underline" onClick={addManual}>"{keyword.trim()}" {t('add_directly')}</button>
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

      {/* Description 입력 모달 */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <Card className="w-96">
            <CardContent className="space-y-4 pt-6">
              <h3 className="text-lg font-semibold mb-2">{t('add_new_part')}</h3>
              <div className="space-y-3">
                <div>
                  <Label htmlFor="modal-part-no">Part No</Label>
                  <Input 
                    id="modal-part-no" 
                    value={modalPartNo} 
                    disabled 
                    className="bg-gray-50" 
                  />
                </div>
                <div>
                  <Label htmlFor="modal-description">{t('description')}</Label>
                  <Input 
                    id="modal-description" 
                    value={modalDescription} 
                    onChange={(e) => setModalDescription(e.target.value)}
                    placeholder={t('description_placeholder')}
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-4">
                <Button type="button" variant="ghost" onClick={() => setModalOpen(false)}>
                  {t('cancel')}
                </Button>
                <Button type="button" onClick={handleModalSubmit}>
                  {t('save')}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </>
  );
} 