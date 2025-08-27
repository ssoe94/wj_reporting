import { useLang } from '@/i18n';
import type { Eco } from '@/hooks/useEcos';
import { X, FileText, Calendar, User, Package, MapPin, Clock, CheckCircle, AlertCircle, Building, Wrench } from 'lucide-react';

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-4xl max-h-[90vh] mx-4 bg-white rounded-xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="relative bg-gradient-to-r from-blue-600 to-blue-700 text-white p-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-white/20 rounded-lg">
                <FileText className="w-6 h-6" />
              </div>
              <div>
                <h2 className="text-xl font-bold">{lang === 'ko' ? 'ECO 조회' : 'ECO 查看'}</h2>
                <p className="text-blue-100 text-sm">{lang === 'ko' ? '공학변경오더 상세정보' : '工程变更订单详细信息'}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {onEdit && (
                <button
                  onClick={onEdit}
                  className="px-4 py-2 bg-white/20 hover:bg-white/30 rounded-lg text-sm font-medium transition-colors"
                >
                  {lang === 'ko' ? '편집' : '编辑'}
                </button>
              )}
              <button
                onClick={onClose}
                className="p-2 hover:bg-white/20 rounded-lg transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="max-h-[calc(90vh-120px)] overflow-y-auto">
          {/* ECO 기본 정보 섹션 */}
          <div className="p-6 border-b border-gray-200">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-1 h-6 bg-blue-500 rounded-full"></div>
              <h3 className="text-lg font-semibold text-gray-900">
                {lang === 'ko' ? '기본 정보' : '基本信息'}
              </h3>
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {/* ECO 번호 */}
              <div className="bg-gradient-to-br from-blue-50 to-blue-100 p-4 rounded-lg">
                <div className="flex items-center gap-2 mb-2">
                  <FileText className="w-4 h-4 text-blue-600" />
                  <label className="text-sm font-medium text-blue-900">ECO {lang === 'ko' ? '번호' : '编号'}</label>
                </div>
                <p className="text-lg font-bold text-blue-800">{eco.eco_no || '-'}</p>
              </div>

              {/* 적용 모델 */}
              <div className="bg-gradient-to-br from-green-50 to-green-100 p-4 rounded-lg">
                <div className="flex items-center gap-2 mb-2">
                  <Package className="w-4 h-4 text-green-600" />
                  <label className="text-sm font-medium text-green-900">
                    {lang === 'ko' ? '적용 모델' : '适用型号'}
                  </label>
                </div>
                <p className="text-lg font-bold text-green-800">{eco.eco_model || '-'}</p>
              </div>

              {/* 고객사 */}
              <div className="bg-gradient-to-br from-purple-50 to-purple-100 p-4 rounded-lg">
                <div className="flex items-center gap-2 mb-2">
                  <Building className="w-4 h-4 text-purple-600" />
                  <label className="text-sm font-medium text-purple-900">
                    {lang === 'ko' ? '고객사' : '客户'}
                  </label>
                </div>
                <p className="text-lg font-bold text-purple-800">{eco.customer || '-'}</p>
              </div>
            </div>

            {/* 상태 */}
            <div className="mt-4 flex items-center gap-4">
              <div className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg ${statusBg}`}>
                <StatusIcon className={`w-5 h-5 ${statusColor}`} />
                <span className={`font-semibold ${statusColor}`}>
                  {eco.status}
                </span>
              </div>
              <div className="text-sm text-gray-600">
                {lang === 'ko' ? '양식 구분:' : '表格区分:'} 
                <span className="ml-1 font-medium">{eco.form_type}</span>
              </div>
            </div>
          </div>

          {/* 날짜 정보 섹션 */}
          <div className="p-6 border-b border-gray-200">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-1 h-6 bg-green-500 rounded-full"></div>
              <h3 className="text-lg font-semibold text-gray-900">
                {lang === 'ko' ? '일정 정보' : '日程信息'}
              </h3>
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="bg-gray-50 p-3 rounded-lg">
                <div className="flex items-center gap-2 mb-1">
                  <Calendar className="w-4 h-4 text-gray-600" />
                  <label className="text-sm font-medium text-gray-700">{t('prepared_date')}</label>
                </div>
                <p className="text-gray-900 font-medium">{formatDate(eco.prepared_date)}</p>
              </div>

              <div className="bg-gray-50 p-3 rounded-lg">
                <div className="flex items-center gap-2 mb-1">
                  <Calendar className="w-4 h-4 text-gray-600" />
                  <label className="text-sm font-medium text-gray-700">{t('issued_date')}</label>
                </div>
                <p className="text-gray-900 font-medium">{formatDate(eco.issued_date)}</p>
              </div>

              <div className="bg-gray-50 p-3 rounded-lg">
                <div className="flex items-center gap-2 mb-1">
                  <Calendar className="w-4 h-4 text-gray-600" />
                  <label className="text-sm font-medium text-gray-700">{t('received_date')}</label>
                </div>
                <p className="text-gray-900 font-medium">{formatDate(eco.received_date)}</p>
              </div>

              <div className="bg-gray-50 p-3 rounded-lg">
                <div className="flex items-center gap-2 mb-1">
                  <Calendar className="w-4 h-4 text-gray-600" />
                  <label className="text-sm font-medium text-gray-700">{t('applicable_date')}</label>
                </div>
                <p className="text-gray-900 font-medium">{formatDate(eco.applicable_date)}</p>
              </div>
            </div>
          </div>

          {/* 변경 정보 섹션 */}
          <div className="p-6 border-b border-gray-200">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-1 h-6 bg-orange-500 rounded-full"></div>
              <h3 className="text-lg font-semibold text-gray-900">
                {lang === 'ko' ? '변경 정보' : '变更信息'}
              </h3>
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label className="text-sm font-medium text-gray-700 mb-2 block">
                  {t('change_reason')}
                </label>
                <div className="bg-amber-50 p-4 rounded-lg border border-amber-200">
                  <p className="text-gray-800 whitespace-pre-wrap">
                    {eco.change_reason || (lang === 'ko' ? '미입력' : '未输入')}
                  </p>
                </div>
              </div>

              <div>
                <label className="text-sm font-medium text-gray-700 mb-2 block">
                  {t('change_details')}
                </label>
                <div className="bg-amber-50 p-4 rounded-lg border border-amber-200">
                  <p className="text-gray-800 whitespace-pre-wrap">
                    {eco.change_details || (lang === 'ko' ? '미입력' : '未输入')}
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* 재고 및 적용 정보 섹션 */}
          <div className="p-6 border-b border-gray-200">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-1 h-6 bg-red-500 rounded-full"></div>
              <h3 className="text-lg font-semibold text-gray-900">
                {lang === 'ko' ? '재고 및 적용 정보' : '库存及应用信息'}
              </h3>
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <div className="bg-red-50 p-3 rounded-lg">
                <div className="flex items-center gap-2 mb-1">
                  <Package className="w-4 h-4 text-red-600" />
                  <label className="text-sm font-medium text-red-700">{t('inventory_finished')}</label>
                </div>
                <p className="text-red-900 font-bold text-lg">
                  {eco.inventory_finished !== null ? eco.inventory_finished.toLocaleString() : '-'}
                </p>
              </div>

              <div className="bg-red-50 p-3 rounded-lg">
                <div className="flex items-center gap-2 mb-1">
                  <Package className="w-4 h-4 text-red-600" />
                  <label className="text-sm font-medium text-red-700">{t('inventory_material')}</label>
                </div>
                <p className="text-red-900 font-bold text-lg">
                  {eco.inventory_material !== null ? eco.inventory_material.toLocaleString() : '-'}
                </p>
              </div>

              <div className="bg-red-50 p-3 rounded-lg">
                <div className="flex items-center gap-2 mb-1">
                  <Wrench className="w-4 h-4 text-red-600" />
                  <label className="text-sm font-medium text-red-700">{t('storage_action')}</label>
                </div>
                <p className="text-red-900 font-medium">
                  {eco.storage_action || (lang === 'ko' ? '미입력' : '未输入')}
                </p>
              </div>
            </div>

            {eco.applicable_work_order && (
              <div className="mt-4 bg-gray-50 p-3 rounded-lg">
                <div className="flex items-center gap-2 mb-1">
                  <MapPin className="w-4 h-4 text-gray-600" />
                  <label className="text-sm font-medium text-gray-700">{t('applicable_work_order')}</label>
                </div>
                <p className="text-gray-900 font-medium">{eco.applicable_work_order}</p>
              </div>
            )}
          </div>

          {/* Part 상세 정보 */}
          {(eco as any).details && (eco as any).details.length > 0 && (
            <div className="p-6">
              <div className="flex items-center gap-2 mb-4">
                <div className="w-1 h-6 bg-purple-500 rounded-full"></div>
                <h3 className="text-lg font-semibold text-gray-900">
                  {lang === 'ko' ? 'Part 상세 정보' : 'Part 详细信息'}
                </h3>
                <span className="bg-purple-100 text-purple-800 text-xs font-medium px-2 py-1 rounded-full">
                  {(eco as any).details.length}{lang === 'ko' ? '개' : '个'}
                </span>
              </div>
              
              <div className="bg-gray-50 rounded-lg overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-gray-100">
                      <tr>
                        <th className="px-4 py-3 text-left text-sm font-semibold text-gray-900">
                          Part No.
                        </th>
                        <th className="px-4 py-3 text-left text-sm font-semibold text-gray-900">
                          {lang === 'ko' ? '설명' : '说明'}
                        </th>
                        <th className="px-4 py-3 text-left text-sm font-semibold text-gray-900">
                          {t('change_details')}
                        </th>
                        <th className="px-4 py-3 text-center text-sm font-semibold text-gray-900">
                          {t('status')}
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                      {(eco as any).details.map((detail: any, index: number) => (
                        <tr key={detail.id || index} className="hover:bg-white">
                          <td className="px-4 py-3">
                            <span className="font-mono text-sm text-blue-600 font-medium">
                              {detail.part_no}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-600">
                            {detail.description || '-'}
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-800">
                            <div className="max-w-xs">
                              <p className="whitespace-pre-wrap line-clamp-3">
                                {detail.change_details || (lang === 'ko' ? '미입력' : '未输入')}
                              </p>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-center">
                            <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${
                              detail.status === 'CLOSED' 
                                ? 'bg-green-100 text-green-800' 
                                : 'bg-blue-100 text-blue-800'
                            }`}>
                              {detail.status}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}