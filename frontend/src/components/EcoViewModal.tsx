import { useLang } from '@/i18n';
import type { Eco } from '@/hooks/useEcos';
import { X, FileText, Calendar, Package, MapPin, Clock, CheckCircle, AlertCircle, Building, Wrench } from 'lucide-react';

interface Props {
  eco: Eco | null;
  open: boolean;
  onClose: () => void;
  onEdit?: () => void;
}

export default function EcoViewModal({ eco, open, onClose, onEdit }: Props) {
  const { lang, t } = useLang();

  if (!open || !eco) return null;

  const statusIcon = eco.status === 'CLOSED' ? CheckCircle : eco.status === 'WIP' ? Clock : AlertCircle;
  const statusColor = eco.status === 'CLOSED' ? 'text-green-600' : eco.status === 'WIP' ? 'text-yellow-600' : 'text-blue-600';
  const statusBg = eco.status === 'CLOSED' ? 'bg-green-50' : eco.status === 'WIP' ? 'bg-yellow-50' : 'bg-blue-50';

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return lang === 'ko' ? '미설정' : '未设置';
    return new Date(dateStr).toLocaleDateString(lang === 'ko' ? 'ko-KR' : 'zh-CN');
  };

  const StatusIcon = statusIcon;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div 
        className="w-full max-w-5xl max-h-[90vh] bg-white rounded-lg shadow-xl overflow-hidden flex flex-col" 
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex-shrink-0 flex items-center justify-between p-4 border-b border-gray-200 bg-gray-50">
          <div className="flex items-center gap-3">
            <FileText className="w-6 h-6 text-blue-600" />
            <div>
              <h2 className="text-lg font-semibold text-gray-800">{eco.eco_no}</h2>
              <p className="text-sm text-gray-500">{t('eco_model')}: {eco.eco_model || '-'}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {onEdit && (
              <button
                onClick={onEdit}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md text-sm font-medium transition-colors"
              >
                {t('edit')}
              </button>
            )}
            <button
              onClick={onClose}
              className="p-2 text-gray-500 hover:text-gray-800 hover:bg-gray-200 rounded-full transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-grow p-6 overflow-y-auto">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Left Column (Main Content) */}
            <div className="lg:col-span-2 space-y-6">
              {/* Change Info */}
              <div className="border border-gray-200 rounded-lg">
                <div className="p-4 border-b border-gray-200">
                  <h3 className="font-semibold text-gray-800">{t('change_information')}</h3>
                </div>
                <div className="p-4 space-y-4">
                  <div>
                    <label className="text-sm font-medium text-gray-600 block mb-1">{t('change_reason')}</label>
                    <div className="p-3 bg-gray-50 rounded-md border border-l-4 border-amber-400 text-gray-800 whitespace-pre-wrap text-sm">
                      {eco.change_reason || '-'}
                    </div>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-gray-600 block mb-1">{t('change_details')}</label>
                    <div className="p-3 bg-gray-50 rounded-md border border-l-4 border-blue-400 text-gray-800 whitespace-pre-wrap text-sm">
                      {eco.change_details || '-'}
                    </div>
                  </div>
                  
                  {/* 관련 PART NO. 리스트 */}
                  {(eco as any).details && (eco as any).details.length > 0 && (
                    <div>
                      <label className="text-sm font-medium text-gray-600 block mb-1">관련 PART NO.</label>
                      <div className="p-3 bg-green-50 rounded-md border border-l-4 border-green-400">
                        <div className="flex flex-wrap gap-2">
                          {(eco as any).details.map((detail: any, index: number) => (
                            <span 
                              key={detail.id || index} 
                              className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800 border border-green-200"
                            >
                              {detail.part_no}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Part Details */}
              {(() => {
                const details = (eco as any).details || [];
                const partDetails = (eco as any).part_details || [];
                const allDetails = [...details, ...partDetails];
                
                if (allDetails.length === 0) return null;
                
                return (
                  <div className="border border-gray-200 rounded-lg">
                    <div className="p-4 border-b border-gray-200 flex justify-between items-center">
                      <h3 className="font-semibold text-gray-800">{t('part_details_info')}</h3>
                      <span className="bg-blue-100 text-blue-800 text-xs font-medium px-2.5 py-1 rounded-full">
                        {allDetails.length} {t('items')}
                      </span>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="px-4 py-2 text-left font-medium text-gray-600">Part No.</th>
                            <th className="px-4 py-2 text-left font-medium text-gray-600">{t('description')}</th>
                            <th className="px-4 py-2 text-left font-medium text-gray-600">{t('change_details')}</th>
                            <th className="px-4 py-2 text-center font-medium text-gray-600">{t('status')}</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-200">
                          {allDetails.map((detail: any, index: number) => (
                            <tr key={detail.id || `part-${index}`}>
                              <td className="px-4 py-2 font-mono">{detail.part_no}</td>
                              <td className="px-4 py-2 text-gray-600">{detail.description || '-'}</td>
                              <td className="px-4 py-2 text-gray-800 whitespace-pre-wrap max-w-md">
                                {(detail.change_details && detail.change_details.length > 200) 
                                  ? detail.change_details.substring(0, 200) + '...' 
                                  : (detail.change_details || '-')
                                }
                              </td>
                              <td className="px-4 py-2 text-center">
                                <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${detail.status === 'CLOSED' ? 'bg-green-100 text-green-800' : 'bg-blue-100 text-blue-800'}`}>
                                  {detail.status}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })()}
            </div>

            {/* Right Column (Metadata) */}
            <div className="space-y-6">
              {/* Status & Key Info */}
              <div className="border border-gray-200 rounded-lg">
                <div className="p-4">
                  <div className="mb-4">
                    <label className="text-sm font-medium text-gray-600 block mb-1">{t('status')}</label>
                    <div className={`inline-flex items-center gap-2 px-3 py-1 rounded-full text-sm font-semibold ${statusBg} ${statusColor}`}>
                      <StatusIcon className="w-4 h-4" />
                      <span>{eco.status}</span>
                    </div>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-gray-600 block mb-1">{t('customer')}</label>
                    <p className="text-gray-800 font-medium">{eco.customer || '-'}</p>
                  </div>
                   <div className="mt-2">
                    <label className="text-sm font-medium text-gray-600 block mb-1">{t('eco_model')}</label>
                    <p className="text-gray-800 font-medium">{eco.eco_model || '-'}</p>
                  </div>
                </div>
              </div>

              {/* Dates */}
              <div className="border border-gray-200 rounded-lg">
                <div className="p-4 border-b border-gray-200">
                  <h3 className="font-semibold text-gray-800">{t('related_dates')}</h3>
                </div>
                <div className="p-4 space-y-3 text-sm">
                  <div className="flex justify-between"><span>{t('prepared_date')}:</span><span className="font-medium">{formatDate(eco.prepared_date)}</span></div>
                  <div className="flex justify-between"><span>{t('issued_date')}:</span><span className="font-medium">{formatDate(eco.issued_date)}</span></div>
                  <div className="flex justify-between"><span>{t('received_date')}:</span><span className="font-medium">{formatDate(eco.received_date)}</span></div>
                  <div className="flex justify-between"><span>{t('applicable_date')}:</span><span className="font-medium text-blue-600">{formatDate(eco.applicable_date)}</span></div>
                </div>
              </div>

              {/* Inventory Info */}
              <div className="border border-gray-200 rounded-lg">
                 <div className="p-4 border-b border-gray-200">
                  <h3 className="font-semibold text-gray-800">{t('inventory_handling')}</h3>
                </div>
                <div className="p-4 space-y-3">
                  <div>
                    <label className="text-sm font-medium text-gray-600 block mb-1">{t('storage_action')}</label>
                    <p className="text-sm text-gray-800 p-2 bg-gray-50 rounded-md">{eco.storage_action || '-'}</p>
                  </div>
                  <div className="flex justify-between text-sm"><span>{t('inventory_finished')}:</span><span className="font-medium">{eco.inventory_finished?.toLocaleString() || '0'}</span></div>
                  <div className="flex justify-between text-sm"><span>{t('inventory_material')}:</span><span className="font-medium">{eco.inventory_material?.toLocaleString() || '0'}</span></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}