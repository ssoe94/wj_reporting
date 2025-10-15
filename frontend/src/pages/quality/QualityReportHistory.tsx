import { FolderOpen, Save, Image as ImageIcon, X, ChevronLeft, ChevronRight, Eye, Trash2, Edit } from 'lucide-react';
import { useLang } from '../../i18n';
import { useState } from 'react';
import { Label } from '../../components/ui/label';
import { Input } from '../../components/ui/input';
import { Button } from '../../components/ui/button';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import api from '../../lib/api';
import { toast } from 'react-toastify';

// 서버에서 받아올 데이터 타입 정의
interface QualityReport {
  id: number;
  report_dt: string;
  section: string;
  model: string;
  part_no: string;
  lot_qty: number | null;
  inspection_qty?: number | null;
  defect_qty?: number | null;
  defect_rate: string;
  judgement: string;
  phenomenon?: string;
  disposition?: string;
  action_result?: string;
  image1?: string;
  image2?: string;
  image3?: string;
}

export default function QualityReportHistory() {
  const { t } = useLang();
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState({
    dateFrom: '',
    dateTo: '',
    model: '',
    part_no: ''
  });
  const [page, setPage] = useState(1);
  const pageSize = 20;
  const [editingId, setEditingId] = useState<number | null>(null);
  const [actionResults, setActionResults] = useState<Record<number, string>>({});
  const [savingId, setSavingId] = useState<number | null>(null);
  const [selectedImages, setSelectedImages] = useState<string[]>([]);
  const [currentImageIndex, setCurrentImageIndex] = useState(0);
  const [selectedReport, setSelectedReport] = useState<QualityReport | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // useQuery를 사용하여 서버에서 데이터 가져오기
  const { data, isLoading, isError } = useQuery({
    queryKey: ['quality-reports', filters, page, pageSize],
    queryFn: async () => {
      const { data } = await api.get('/quality/reports/', {
        params: {
          page: page,
          page_size: pageSize,
          report_dt_after: filters.dateFrom || undefined,
          report_dt_before: filters.dateTo || undefined,
          model__icontains: filters.model || undefined,
          part_no__icontains: filters.part_no || undefined,
        }
      });
      return data;
    },
    placeholderData: (previousData) => previousData,
  });

  const reports = data?.results || [];
  const totalCount = data?.count || 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  const handleSaveActionResult = async (reportId: number) => {
    const actionResult = actionResults[reportId] || '';
    setSavingId(reportId);
    try {
      await api.patch(`/quality/reports/${reportId}/`, {
        action_result: actionResult
      });
      toast.success(t('save_success'));
      queryClient.invalidateQueries({ queryKey: ['quality-reports'] });
      setEditingId(null);
    } catch (err) {
      toast.error(t('save_fail'));
    } finally {
      setSavingId(null);
    }
  };

  const handleDeleteReport = async (reportId: number) => {
    if (!window.confirm(t('quality.confirm_delete'))) {
      return;
    }
    
    setIsDeleting(true);
    try {
      await api.delete(`/quality/reports/${reportId}/`);
      toast.success(t('delete_success'));
      queryClient.invalidateQueries({ queryKey: ['quality-reports'] });
      setSelectedReport(null);
    } catch (err) {
      toast.error(t('delete_fail'));
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className="rounded-lg border border-gray-200 bg-white shadow-sm">
      <div className="flex items-center gap-2 border-b border-gray-200 px-4 py-3 bg-gradient-to-r from-indigo-50 to-white">
        <FolderOpen className="w-5 h-5 text-indigo-600" />
        <h2 className="text-base font-semibold text-gray-800">{t('quality.history_title')}</h2>
      </div>
      <div className="p-4 space-y-4">
        {/* 필터 */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <div>
            <Label>{t('start_date')}</Label>
            <Input type="date" value={filters.dateFrom} onChange={e => { setPage(1); setFilters(f => ({ ...f, dateFrom: e.target.value })); }} />
          </div>
          <div>
            <Label>{t('end_date')}</Label>
            <Input type="date" value={filters.dateTo} onChange={e => { setPage(1); setFilters(f => ({ ...f, dateTo: e.target.value })); }} />
          </div>
          <div>
            <Label>{t('model')}</Label>
            <Input value={filters.model} onChange={e => { setPage(1); setFilters(f => ({ ...f, model: e.target.value })); }} placeholder={t('quality.model_placeholder')} />
          </div>
          <div>
            <Label>{t('part_no')}</Label>
            <Input value={filters.part_no} onChange={e => { setPage(1); setFilters(f => ({ ...f, part_no: e.target.value })); }} placeholder={t('quality.part_no_placeholder')} />
          </div>
        </div>
        {/* 테이블 */}
        <div className="overflow-x-auto border border-indigo-200 rounded-lg shadow-sm">
          <table className="min-w-full text-sm">
            <thead className="bg-gradient-to-r from-indigo-50 to-blue-50 whitespace-nowrap">
              <tr className="border-b border-indigo-200">
                <th className="px-3 py-3 text-center font-semibold text-gray-700">{t('date')}</th>
                <th className="px-3 py-3 text-center font-semibold text-gray-700">{t('quality.section')}</th>
                <th className="px-3 py-3 text-center font-semibold text-gray-700">{t('model')}</th>
                <th className="px-3 py-3 text-center font-semibold text-gray-700">{t('part_no')}</th>
                <th className="px-3 py-3 text-center font-semibold text-gray-700">{t('quality.lot_size')}</th>
                <th className="px-3 py-3 text-center font-semibold text-gray-700">{t('quality.defect_rate')}</th>
                <th className="px-3 py-3 text-center font-semibold text-gray-700">{t('quality.judgement')}</th>
                <th className="px-3 py-3 text-center font-semibold text-gray-700">{t('quality.image_upload')}</th>
                <th className="px-3 py-3 text-center font-semibold text-gray-700 min-w-[250px]">{t('quality.action_result')}</th>
                <th className="px-3 py-3 text-center font-semibold text-gray-700">{t('quality.actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-indigo-100 bg-white">
              {isLoading ? (
                <tr><td colSpan={10} className="text-center py-10 text-gray-500">{t('loading')}...</td></tr>
              ) : isError ? (
                <tr><td colSpan={10} className="text-center py-10 text-red-500">{t('error_loading_data')}</td></tr>
              ) : reports.length === 0 ? (
                <tr><td colSpan={10} className="text-center py-10 text-gray-500">{t('no_data')}</td></tr>
              ) : (
                reports.map((r: QualityReport) => {
                  const isEditing = editingId === r.id;
                  const currentValue = actionResults[r.id] !== undefined ? actionResults[r.id] : (r.action_result || '');
                  
                  return (
                    <tr key={r.id} className="hover:bg-indigo-50/50 transition-colors duration-150">
                      <td className="px-3 py-3 text-center text-gray-700 whitespace-nowrap">{(r.report_dt || '').replace('T', ' ').slice(0, 16)}</td>
                      <td className="px-3 py-3 text-center text-gray-700 whitespace-nowrap">{r.section}</td>
                      <td className="px-3 py-3 text-center text-gray-700 whitespace-nowrap">{r.model}</td>
                      <td className="px-3 py-3 text-center text-gray-700 whitespace-nowrap">{r.part_no}</td>
                      <td className="px-3 py-3 text-center text-gray-700 whitespace-nowrap">{r.lot_qty}</td>
                      <td className="px-3 py-3 text-center text-gray-700 whitespace-nowrap">{r.defect_rate}</td>
                      <td className="px-3 py-3 text-center text-gray-700 whitespace-nowrap">{r.judgement}</td>
                      <td className="px-3 py-3 text-center">
                        {(() => {
                          const images = [r.image1, r.image2, r.image3].filter(Boolean) as string[];
                          if (images.length === 0) {
                            return <span className="text-gray-400 text-xs">-</span>;
                          }
                          
                          // 이미지 URL 처리 (Cloudinary는 절대 URL 반환)
                          const getImageUrl = (url: string) => {
                            // 이미 절대 URL인 경우 (Cloudinary)
                            if (url.startsWith('http://') || url.startsWith('https://')) {
                              return url;
                            }
                            // 상대 경로인 경우 (로컬 개발 또는 기존 이미지)
                            // API 베이스 URL 사용 (프록시를 통해 백엔드로 전달)
                            const apiBase = import.meta.env.VITE_API_BASE_URL || '';
                            // /media로 시작하는 경우 백엔드 서버 URL 사용
                            if (url.startsWith('/media')) {
                              // 개발 환경: localhost:8000, 프로덕션: API 서버
                              const backendUrl = apiBase || 'http://localhost:8000';
                              return `${backendUrl}${url}`;
                            }
                            return `${apiBase}${url.startsWith('/') ? url : '/' + url}`;
                          };
                          
                          return (
                            <div className="flex items-center justify-center gap-1">
                              <button
                                onClick={() => {
                                  setSelectedImages(images.map(getImageUrl));
                                  setCurrentImageIndex(0);
                                }}
                                className="relative"
                              >
                                <img
                                  src={getImageUrl(images[0])}
                                  alt="Thumbnail"
                                  className="w-12 h-12 object-cover rounded border border-indigo-200 hover:border-indigo-400 transition-all cursor-pointer"
                                  onError={(e) => {
                                    console.error('Image load error:', images[0]);
                                    e.currentTarget.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="48" height="48"%3E%3Crect fill="%23ddd" width="48" height="48"/%3E%3Ctext x="50%25" y="50%25" text-anchor="middle" dy=".3em" fill="%23999"%3E?%3C/text%3E%3C/svg%3E';
                                  }}
                                />
                                {images.length > 1 && (
                                  <span className="absolute -top-1 -right-1 bg-indigo-600 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center font-bold">
                                    {images.length}
                                  </span>
                                )}
                              </button>
                            </div>
                          );
                        })()}
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-2">
                          <Input
                            value={currentValue}
                            onChange={(e) => {
                              setActionResults(prev => ({ ...prev, [r.id]: e.target.value }));
                              if (!isEditing) setEditingId(r.id);
                            }}
                            placeholder={t('quality.action_result_placeholder')}
                            className="text-sm min-w-[200px]"
                          />
                          {isEditing && (
                            <Button
                              size="sm"
                              onClick={() => handleSaveActionResult(r.id)}
                              disabled={savingId === r.id}
                              className="bg-indigo-600 hover:bg-indigo-700 text-white whitespace-nowrap"
                            >
                              {savingId === r.id ? (
                                <span className="flex items-center gap-1">
                                  <Save className="w-3 h-3 animate-pulse" />
                                  {t('saving')}
                                </span>
                              ) : (
                                <span className="flex items-center gap-1">
                                  <Save className="w-3 h-3" />
                                  {t('quality.save_action')}
                                </span>
                              )}
                            </Button>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex items-center justify-center gap-2">
                          <button
                            onClick={() => setSelectedReport(r)}
                            className="p-2 text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
                            title={t('quality.view_detail')}
                          >
                            <Eye className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => handleDeleteReport(r.id)}
                            className="p-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                            title={t('quality.delete_report')}
                            disabled={isDeleting}
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        {/* 페이지네이션 */}
        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="secondary" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}>{t('quality.prev_page')}</Button>
          <span className="text-xs text-gray-500">{page} / {totalPages}</span>
          <Button type="button" variant="secondary" onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages}>{t('quality.next_page')}</Button>
        </div>
      </div>

      {/* 이미지 모달 (다중 이미지 지원) */}
      {selectedImages.length > 0 && (
        <div
          className="fixed inset-0 bg-black/90 flex items-center justify-center z-50 p-4"
          onClick={() => {
            setSelectedImages([]);
            setCurrentImageIndex(0);
          }}
        >
          <div className="relative max-w-5xl max-h-[90vh] w-full">
            {/* 닫기 버튼 */}
            <button
              onClick={() => {
                setSelectedImages([]);
                setCurrentImageIndex(0);
              }}
              className="absolute -top-12 right-0 text-white hover:text-gray-300 transition-colors z-10"
            >
              <X className="w-8 h-8" />
            </button>

            {/* 이미지 카운터 */}
            {selectedImages.length > 1 && (
              <div className="absolute -top-12 left-1/2 transform -translate-x-1/2 text-white text-sm">
                {currentImageIndex + 1} / {selectedImages.length}
              </div>
            )}

            {/* 이미지 컨테이너 */}
            <div className="relative">
              <img
                src={selectedImages[currentImageIndex]}
                alt={`Image ${currentImageIndex + 1}`}
                className="w-full h-full max-h-[85vh] object-contain rounded-lg"
                onClick={(e) => e.stopPropagation()}
              />

              {/* 이전 버튼 */}
              {selectedImages.length > 1 && currentImageIndex > 0 && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setCurrentImageIndex(prev => prev - 1);
                  }}
                  className="absolute left-4 top-1/2 transform -translate-y-1/2 bg-black/50 hover:bg-black/70 text-white rounded-full p-3 transition-all"
                >
                  <ChevronLeft className="w-6 h-6" />
                </button>
              )}

              {/* 다음 버튼 */}
              {selectedImages.length > 1 && currentImageIndex < selectedImages.length - 1 && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setCurrentImageIndex(prev => prev + 1);
                  }}
                  className="absolute right-4 top-1/2 transform -translate-y-1/2 bg-black/50 hover:bg-black/70 text-white rounded-full p-3 transition-all"
                >
                  <ChevronRight className="w-6 h-6" />
                </button>
              )}
            </div>

            {/* 썸네일 네비게이션 */}
            {selectedImages.length > 1 && (
              <div className="flex justify-center gap-2 mt-4">
                {selectedImages.map((img, idx) => (
                  <button
                    key={idx}
                    onClick={(e) => {
                      e.stopPropagation();
                      setCurrentImageIndex(idx);
                    }}
                    className={`w-16 h-16 rounded border-2 overflow-hidden transition-all ${
                      idx === currentImageIndex
                        ? 'border-indigo-500 scale-110'
                        : 'border-gray-400 opacity-60 hover:opacity-100'
                    }`}
                  >
                    <img
                      src={img}
                      alt={`Thumbnail ${idx + 1}`}
                      className="w-full h-full object-cover"
                    />
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 상세보기 모달 */}
      {selectedReport && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
          onClick={() => setSelectedReport(null)}
        >
          <div
            className="bg-white rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            {/* 헤더 */}
            <div className="sticky top-0 bg-gradient-to-r from-indigo-600 to-blue-600 text-white px-6 py-4 flex items-center justify-between rounded-t-lg">
              <h3 className="text-lg font-semibold">{t('quality.detail_title')}</h3>
              <button
                onClick={() => setSelectedReport(null)}
                className="text-white hover:text-gray-200 transition-colors"
              >
                <X className="w-6 h-6" />
              </button>
            </div>

            {/* 내용 */}
            <div className="p-6 space-y-6">
              {/* 기본 정보 */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {t('quality.report_datetime')}
                  </label>
                  <div className="text-gray-900 bg-gray-50 px-3 py-2 rounded border">
                    {selectedReport.report_dt.replace('T', ' ').slice(0, 16)}
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {t('quality.section')}
                  </label>
                  <div className="text-gray-900 bg-gray-50 px-3 py-2 rounded border">
                    {selectedReport.section}
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {t('model')}
                  </label>
                  <div className="text-gray-900 bg-gray-50 px-3 py-2 rounded border">
                    {selectedReport.model}
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {t('part_no')}
                  </label>
                  <div className="text-gray-900 bg-gray-50 px-3 py-2 rounded border">
                    {selectedReport.part_no}
                  </div>
                </div>
              </div>

              {/* 수량 정보 */}
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {t('quality.lot_size')}
                  </label>
                  <div className="text-gray-900 bg-gray-50 px-3 py-2 rounded border">
                    {selectedReport.lot_qty || '-'}
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {t('quality.inspection_qty')}
                  </label>
                  <div className="text-gray-900 bg-gray-50 px-3 py-2 rounded border">
                    {(selectedReport as any).inspection_qty || '-'}
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {t('quality.defect_qty')}
                  </label>
                  <div className="text-gray-900 bg-gray-50 px-3 py-2 rounded border">
                    {(selectedReport as any).defect_qty || '-'}
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {t('quality.defect_rate')}
                  </label>
                  <div className="text-gray-900 bg-gray-50 px-3 py-2 rounded border">
                    {selectedReport.defect_rate}
                  </div>
                </div>
              </div>

              {/* 판정 결과 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('quality.judgement')}
                </label>
                <div className={`inline-block px-4 py-2 rounded-full font-semibold ${
                  selectedReport.judgement === 'OK' 
                    ? 'bg-green-100 text-green-800' 
                    : 'bg-red-100 text-red-800'
                }`}>
                  {selectedReport.judgement}
                </div>
              </div>

              {/* 불량 현상 */}
              {(selectedReport as any).phenomenon && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {t('quality.defect_phenomenon')}
                  </label>
                  <div className="text-gray-900 bg-gray-50 px-3 py-2 rounded border whitespace-pre-wrap">
                    {(selectedReport as any).phenomenon}
                  </div>
                </div>
              )}

              {/* 처리 방식 */}
              {(selectedReport as any).disposition && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {t('quality.disposition')}
                  </label>
                  <div className="text-gray-900 bg-gray-50 px-3 py-2 rounded border whitespace-pre-wrap">
                    {(selectedReport as any).disposition}
                  </div>
                </div>
              )}

              {/* 처리 결과 */}
              {selectedReport.action_result && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {t('quality.action_result')}
                  </label>
                  <div className="text-gray-900 bg-gray-50 px-3 py-2 rounded border whitespace-pre-wrap">
                    {selectedReport.action_result}
                  </div>
                </div>
              )}

              {/* 이미지 */}
              {(() => {
                const images = [selectedReport.image1, selectedReport.image2, selectedReport.image3].filter(Boolean) as string[];
                if (images.length === 0) return null;
                
                // 이미지 URL 처리 (Cloudinary는 절대 URL 반환)
                const getImageUrl = (url: string) => {
                  // 이미 절대 URL인 경우 (Cloudinary)
                  if (url.startsWith('http://') || url.startsWith('https://')) {
                    return url;
                  }
                  // 상대 경로인 경우 (로컬 개발 또는 기존 이미지)
                  // API 베이스 URL 사용 (프록시를 통해 백엔드로 전달)
                  const apiBase = import.meta.env.VITE_API_BASE_URL || '';
                  // /media로 시작하는 경우 백엔드 서버 URL 사용
                  if (url.startsWith('/media')) {
                    // 개발 환경: localhost:8000, 프로덕션: API 서버
                    const backendUrl = apiBase || 'http://localhost:8000';
                    return `${backendUrl}${url}`;
                  }
                  return `${apiBase}${url.startsWith('/') ? url : '/' + url}`;
                };
                
                return (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      {t('quality.image_upload')}
                    </label>
                    <div className="grid grid-cols-3 gap-4">
                      {images.map((img, idx) => (
                        <div key={idx} className="relative group">
                          <img
                            src={getImageUrl(img)}
                            alt={`Image ${idx + 1}`}
                            className="w-full h-48 object-cover rounded-lg border-2 border-gray-200 cursor-pointer hover:border-indigo-400 transition-all"
                            onClick={() => {
                              setSelectedImages(images.map(getImageUrl));
                              setCurrentImageIndex(idx);
                            }}
                            onError={(e) => {
                              console.error('Image load error:', img);
                              e.currentTarget.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="200" height="200"%3E%3Crect fill="%23ddd" width="200" height="200"/%3E%3Ctext x="50%25" y="50%25" text-anchor="middle" dy=".3em" fill="%23999" font-size="20"%3EImage Error%3C/text%3E%3C/svg%3E';
                            }}
                          />
                          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-all rounded-lg flex items-center justify-center">
                            <Eye className="w-8 h-8 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}
            </div>

            {/* 푸터 - 액션 버튼 */}
            <div className="sticky bottom-0 bg-gray-50 px-6 py-4 flex items-center justify-end gap-3 rounded-b-lg border-t">
              <Button
                variant="secondary"
                onClick={() => setSelectedReport(null)}
              >
                {t('close')}
              </Button>
              <Button
                variant="destructive"
                onClick={() => handleDeleteReport(selectedReport.id)}
                disabled={isDeleting}
                className="bg-red-600 hover:bg-red-700 text-white"
              >
                {isDeleting ? (
                  <span className="flex items-center gap-2">
                    <Trash2 className="w-4 h-4 animate-pulse" />
                    {t('deleting')}...
                  </span>
                ) : (
                  <span className="flex items-center gap-2">
                    <Trash2 className="w-4 h-4" />
                    {t('quality.delete_report')}
                  </span>
                )}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}