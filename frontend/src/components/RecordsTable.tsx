import { useState } from 'react';
import { ChevronDown, ChevronRight, Pencil, Trash2 } from 'lucide-react';
import { useReports } from '@/hooks/useReports';
import { useLang } from '@/i18n';
import type { Report } from '@/hooks/useReports';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import api from '@/lib/api';
import { toast } from 'react-toastify';
import { Input } from '@/components/ui/input';
import { Dialog } from '@headlessui/react';
import { Textarea } from '@/components/ui/textarea';
import { useQueryClient } from '@tanstack/react-query';



export default function RecordsTable() {
  const { data: reports = [], isLoading } = useReports();
  const [expanded, setExpanded] = useState<{ [key: string]: boolean }>({});
  const [editing, setEditing] = useState<Report | null>(null);
  const { t } = useLang();
  const queryClient = useQueryClient();

  const grouped = reports.reduce<{ [key: string]: Report[] }>((acc, r) => {
    acc[r.date] = acc[r.date] ? [...acc[r.date], r] : [r];
    return acc;
  }, {});

  const toggle = (date: string) => setExpanded((prev) => ({ ...prev, [date]: !prev[date] }));

  const closeDialog = () => setEditing(null);

  const handleDelete = async (id: number) => {
    if (!confirm(t('confirm_delete') || '정말 삭제하시겠습니까?')) return;
    try {
      await api.delete(`/reports/${id}/`);
      toast.success(t('delete_success'));
      queryClient.invalidateQueries({ queryKey: ['reports'] });
    } catch {
      toast.error(t('delete_fail'));
    }
  };

  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    try {
      await api.patch(`/reports/${editing.id}/`, editing);
      toast.success(t('update_success'));
      queryClient.invalidateQueries({ queryKey: ['reports'] });
      closeDialog();
    } catch {
      toast.error(t('update_fail'));
    }
  };

  if (isLoading) return <p className="text-gray-500">{t('loading')}</p>;

  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-blue-700">{t('records_title')}</h2>
      </CardHeader>
      <CardContent>
        {Object.keys(grouped).length === 0 ? (
          <p className="text-gray-500">{t('no_data')}</p>
        ) : (
          <div className="space-y-4">
            {Object.entries(grouped).map(([date, list]) => {
              const open = !!expanded[date];
              const totalPlan = list.reduce((s, r) => s + r.plan_qty, 0);
              const totalActual = list.reduce((s, r) => s + r.actual_qty, 0);
              return (
                <div key={date}>
                  <button
                    className="flex w-full items-center justify-between rounded-md bg-gray-100 px-4 py-2 hover:bg-gray-200"
                    onClick={() => toggle(date)}
                  >
                    <span className="font-medium">{date}</span>
                    <span className="text-sm text-gray-600">
                      {t('plan_qty').replace('*','')} {totalPlan} / {t('actual_qty').replace('*','')} {totalActual}
                    </span>
                    {open ? <ChevronDown className="h-5 w-5" /> : <ChevronRight className="h-5 w-5" />}
                  </button>
                  {open && (
                    <table className="mt-2 w-full text-sm">
                      <thead className="bg-gray-50 text-xs text-gray-500">
                        <tr>
                          <th className="px-2 py-1 text-center">{t('header_model')}</th>
                          <th className="px-2 py-1 text-center">{t('header_machine')}</th>
                          <th className="px-2 py-1 text-center">{t('header_tonnage')}</th>
                          <th className="px-2 py-1 text-center">{t('header_plan')}</th>
                          <th className="px-2 py-1 text-center">{t('header_actual')}</th>
                          <th className="px-2 py-1 text-center">{t('header_defect')}</th>
                          <th className="px-2 py-1 text-center">{t('header_start')}</th>
                          <th className="px-2 py-1 text-center">{t('header_end')}</th>
                          <th className="px-2 py-1 text-center">{t('header_run')}</th>
                          <th className="px-2 py-1 text-center w-52">{t('header_note')}</th>
                          <th className="px-2 py-1 text-center w-20">{t('header_action')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...list].sort((a, b) => (a.machine_no ?? 0) - (b.machine_no ?? 0)).map((r) => (
                          <tr key={r.id} className="border-b last:border-0">
                            <td className="px-2 py-1 text-center whitespace-pre-line">
                              <span className="block">
                                {r.model}
                                {r.section ? ` - ${r.section}` : ''}
                              </span>
                              {r.part_no && (
                                <span className="block text-gray-500">{r.part_no}</span>
                              )}
                            </td>
                            <td className="px-2 py-1 text-center">{r.machine_no}</td>
                            <td className="px-2 py-1 text-center">{r.tonnage}</td>
                            <td className="px-2 py-1 text-center">{r.plan_qty}</td>
                            <td className="px-2 py-1 text-center">{r.actual_qty}</td>
                            <td className="px-2 py-1 text-center">{r.actual_defect}</td>
                            <td className="px-2 py-1 text-center whitespace-nowrap">
                              {r.start_datetime && (
                                <>
                                  <span className="block">{r.start_datetime.replace('T',' ').slice(0,10)}</span>
                                  <span className="block">{r.start_datetime.replace('T',' ').slice(11,16)}</span>
                                </>
                              )}
                            </td>
                            <td className="px-2 py-1 text-center whitespace-nowrap">
                              {r.end_datetime && (
                                <>
                                  <span className="block">{r.end_datetime.replace('T',' ').slice(0,10)}</span>
                                  <span className="block">{r.end_datetime.replace('T',' ').slice(11,16)}</span>
                                </>
                              )}
                            </td>
                            <td className="px-2 py-1 text-center">{r.operation_time}</td>
                            <td className="px-2 py-1 text-left w-52 max-w-[210px] align-top relative group">
                              <span className="line-clamp-2 whitespace-pre-line">{r.note}</span>
                              {r.note && (
                                <div className="pointer-events-none absolute left-0 top-full mt-1 hidden w-72 whitespace-pre-line rounded border bg-white p-2 text-xs shadow-lg group-hover:block z-50">
                                  {r.note}
                                </div>
                              )}
                            </td>
                            <td className="px-2 py-1 w-20 flex justify-center gap-2 align-top">
                              <Button variant="ghost" size="icon" className="h-6 w-6 p-0 text-gray-600 hover:text-blue-600" onClick={() => setEditing(r)}>
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button variant="ghost" size="icon" className="h-6 w-6 p-0 text-gray-600 hover:text-red-600" onClick={() => handleDelete(r.id)}>
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>

      {/* Edit modal */}
      <Dialog open={!!editing} onClose={closeDialog} className="fixed inset-0 z-50 flex items-center justify-center">
        <div className="absolute inset-0 bg-black/50" aria-hidden="true" />
        {editing && (
          <Dialog.Panel className="relative w-full max-w-lg rounded-lg bg-white p-6 space-y-4">
            <Dialog.Title className="text-lg font-semibold">{t('modal_edit_title')}</Dialog.Title>
            <form className="space-y-4" onSubmit={handleUpdate}>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm mb-1">{t('model')}</label>
                  <Input value={editing.model} onChange={(e)=>setEditing({...editing, model:e.target.value})} />
                </div>
                <div>
                  <label className="block text-sm mb-1">{t('machine_no')}</label>
                  <Input type="number" value={editing.machine_no} onChange={(e)=>setEditing({...editing, machine_no:Number(e.target.value)})} />
                </div>
                <div>
                  <label className="block text-sm mb-1">{t('tonnage')}</label>
                  <Input value={editing.tonnage} onChange={(e)=>setEditing({...editing, tonnage:e.target.value})} />
                </div>
                <div>
                  <label className="block text-sm mb-1">{t('header_plan')}</label>
                  <Input type="number" value={editing.plan_qty} onChange={(e)=>setEditing({...editing, plan_qty:Number(e.target.value)})} />
                </div>
                <div>
                  <label className="block text-sm mb-1">{t('header_actual')}</label>
                  <Input type="number" value={editing.actual_qty} onChange={(e)=>setEditing({...editing, actual_qty:Number(e.target.value)})} />
                </div>
                <div>
                  <label className="block text-sm mb-1">{t('header_defect')}</label>
                  <Input type="number" value={editing.actual_defect} onChange={(e)=>setEditing({...editing, actual_defect:Number(e.target.value)})} />
                </div>
                <div>
                  <label className="block text-sm mb-1">{t('start_dt')}</label>
                  <Input type="datetime-local" value={editing.start_datetime?.slice(0,16) ?? ''} onChange={(e)=>setEditing({...editing, start_datetime:e.target.value})} />
                </div>
                <div>
                  <label className="block text-sm mb-1">{t('end_dt')}</label>
                  <Input type="datetime-local" value={editing.end_datetime?.slice(0,16) ?? ''} onChange={(e)=>setEditing({...editing, end_datetime:e.target.value})} />
                </div>
                <div>
                  <label className="block text-sm mb-1">{t('total_time')}</label>
                  <Input type="number" value={editing.total_time ?? ''} onChange={(e)=>setEditing({...editing, total_time:+e.target.value})} />
                </div>
                <div>
                  <label className="block text-sm mb-1">{t('idle_time')}</label>
                  <Input type="number" value={editing.total_time && editing.operation_time ? editing.total_time - editing.operation_time : ''} onChange={(e)=>{
                    const idle = Number(e.target.value);
                    const total = editing.total_time || 0;
                    setEditing({...editing, operation_time: Math.max(total - idle,0)});
                  }} />
                </div>
                <div className="col-span-2">
                  <label className="block text-sm mb-1">{t('header_note')}</label>
                  <Textarea value={editing.note} onChange={(e)=>setEditing({...editing, note:e.target.value})} />
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={closeDialog}>{t('cancel')}</Button>
                <Button type="submit">{t('save')}</Button>
              </div>
            </form>
          </Dialog.Panel>
        )}
      </Dialog>
    </Card>
  );
} 