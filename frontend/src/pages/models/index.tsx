import { useState } from 'react';
import { Card, CardContent, CardHeader } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { useLang } from '../../i18n';
import { usePartSpecs, usePartSpecSearch } from '../../hooks/usePartSpecs';
import { Plus, Search, Edit, Trash2 } from 'lucide-react';
import { toast } from 'react-toastify';
import api from '../../lib/api';
import { useQueryClient } from '@tanstack/react-query';

export default function ModelsPage() {
  const { t } = useLang();
  const queryClient = useQueryClient();
  const { data: partSpecs = [], isLoading: partSpecsLoading } = usePartSpecs();

  const [searchTerm, setSearchTerm] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingPart, setEditingPart] = useState<any>(null);

  const initialForm = {
    part_no: '', model_code: '', description: '', mold_type: '', color: '', resin_type: '', resin_code: '',
    net_weight_g: '', sr_weight_g: '', cycle_time_sec: '', cavity: '', valid_from: new Date().toISOString().slice(0,10),
  };
  const [form, setForm] = useState<any>(initialForm);

  const { data: searchParts = [], isFetching: searchLoading } = usePartSpecSearch(searchTerm.toUpperCase());
  const filteredPartSpecs = searchTerm.trim() ? searchParts : partSpecs;

  const handleEditPart = (part: any) => {
    setEditingPart(part);
    setForm({
      part_no: part.part_no,
      model_code: part.model_code,
      description: part.description || '',
      mold_type: part.mold_type || '',
      color: part.color || '',
      resin_type: part.resin_type || '',
      resin_code: part.resin_code || '',
      net_weight_g: part.net_weight_g || '',
      sr_weight_g: part.sr_weight_g || '',
      cycle_time_sec: part.cycle_time_sec || '',
      cavity: part.cavity || '',
      valid_from: part.valid_from || new Date().toISOString().slice(0,10)
    });
    setShowAddModal(true);
  };

  const handleDeletePart = async (part: any) => {
    if (!confirm(`"${part.part_no}" 를 삭제하시겠습니까?`)) return;
    try {
      await api.delete(`/injection/parts/${part.id}/`);
      toast.success('삭제되었습니다');
      queryClient.invalidateQueries({queryKey:['parts-all']});
    } catch (err: any) {
      toast.error('삭제 실패');
    }
  };

  return (
    <div className="p-4">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">{t('modelsTitle')}</h1>
        <p className="text-gray-600 mt-2">{t('models_desc')}</p>
      </div>

      {/* 검색 */}
      <div className="mb-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 h-4 w-4" />
          <Input
            type="text"
            placeholder={t('models_search_placeholder')}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10"
          />
        </div>
      </div>

      {/* Part Spec Table */}
      <Card>
        <CardHeader>
          <div className="flex justify-between items-center">
            <h2 className="text-xl font-semibold">Part Specifications</h2>
            <Button size="sm" className="gap-2" onClick={()=>{setForm(initialForm);setEditingPart(null);setShowAddModal(true);}}>
              <Plus className="h-4 w-4" />
              {t('new_part_spec_btn')}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {(partSpecsLoading || searchLoading) ? (
            <div className="text-center py-8">로딩 중...</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-2 text-left">Part No.</th>
                    <th className="px-4 py-2 text-left">Model Code</th>
                    <th className="px-4 py-2 text-left">Description</th>
                    <th className="px-4 py-2 text-left">Resin Type</th>
                    <th className="px-4 py-2 text-left">Net Weight (g)</th>
                    <th className="px-4 py-2 text-left">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredPartSpecs.map((part) => (
                    <tr key={part.id} className="border-t border-gray-200 hover:bg-gray-50">
                      <td className="px-4 py-2 font-mono">{part.part_no}</td>
                      <td className="px-4 py-2">{part.model_code}</td>
                      <td className="px-4 py-2">{part.description}</td>
                      <td className="px-4 py-2">{part.resin_type || '-'}</td>
                      <td className="px-4 py-2">{part.net_weight_g || '-'}</td>
                      <td className="px-4 py-2">
                        <div className="flex space-x-2">
                          <Button variant="ghost" size="sm" onClick={() => handleEditPart(part)}>
                            <Edit className="h-4 w-4" />
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => handleDeletePart(part)}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg w-[420px] p-6 space-y-4">
            <h3 className="text-lg font-semibold mb-2">{editingPart ? 'Part Spec 수정' : '새 Part Spec 추가'}</h3>
            <div className="grid grid-cols-2 gap-3">
              <input placeholder="Part No" className="border rounded px-2 py-1 col-span-2" value={form.part_no} onChange={e=>setForm({...form,part_no:e.target.value})}/>
              <input placeholder="Model" className="border rounded px-2 py-1 col-span-2" value={form.model_code} onChange={e=>setForm({...form,model_code:e.target.value})}/>
              <input placeholder="Description" className="border rounded px-2 py-1 col-span-2" value={form.description} onChange={e=>setForm({...form,description:e.target.value})}/>
              <input placeholder="Mold Type" className="border rounded px-2 py-1" value={form.mold_type} onChange={e=>setForm({...form,mold_type:e.target.value})}/>
              <input placeholder="Color" className="border rounded px-2 py-1" value={form.color} onChange={e=>setForm({...form,color:e.target.value})}/>
              <input placeholder="Resin Type" className="border rounded px-2 py-1" value={form.resin_type} onChange={e=>setForm({...form,resin_type:e.target.value})}/>
              <input placeholder="Resin Code" className="border rounded px-2 py-1" value={form.resin_code} onChange={e=>setForm({...form,resin_code:e.target.value})}/>
              <input placeholder="Net(g)" className="border rounded px-2 py-1" value={form.net_weight_g} onChange={e=>setForm({...form,net_weight_g:e.target.value})}/>
              <input placeholder="S/R(g)" className="border rounded px-2 py-1" value={form.sr_weight_g} onChange={e=>setForm({...form,sr_weight_g:e.target.value})}/>
              <input placeholder="C/T(초)" className="border rounded px-2 py-1" value={form.cycle_time_sec} onChange={e=>setForm({...form,cycle_time_sec:e.target.value})}/>
              <input placeholder="Cavity" className="border rounded px-2 py-1" value={form.cavity} onChange={e=>setForm({...form,cavity:e.target.value})}/>
              <input type="date" className="border rounded px-2 py-1" value={form.valid_from} onChange={e=>setForm({...form,valid_from:e.target.value})}/>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" size="sm" onClick={()=>{setShowAddModal(false); setEditingPart(null);}}>취소</Button>
              <Button size="sm" onClick={async()=>{
                try{
                  const payload = {
                    part_no:form.part_no, model_code:form.model_code, description:form.description,
                    mold_type:form.mold_type,color:form.color,resin_type:form.resin_type,resin_code:form.resin_code,
                    net_weight_g:Number(form.net_weight_g)||null,sr_weight_g:Number(form.sr_weight_g)||null,
                    cycle_time_sec:Number(form.cycle_time_sec)||null,cavity:Number(form.cavity)||null,
                    valid_from:form.valid_from
                  };
                  
                  if (editingPart) {
                    await api.put(`/injection/parts/${editingPart.id}/`, payload);
                    toast.success('수정되었습니다');
                  } else {
                    await api.post('/injection/parts/', payload);
                    toast.success('저장되었습니다');
                  }
                  
                  queryClient.invalidateQueries({queryKey:['parts-all']});
                  queryClient.invalidateQueries({queryKey:['parts-search']});
                  setShowAddModal(false);
                  setEditingPart(null);
                }catch(err:any){
                  toast.error(editingPart ? '수정 실패' : '저장 실패');
                }
              }}>{editingPart ? '수정' : '저장'}</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
} 