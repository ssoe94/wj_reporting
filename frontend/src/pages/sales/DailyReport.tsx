import { useState, useMemo } from 'react';
import { format } from 'date-fns';
import { useDailyReport, useDailyReportSummary, useCreateSnapshot } from '../../hooks/useDailyReport';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { toast } from 'react-toastify';
import { useLang } from '../../i18n';
import DailyReportCalendar from '../../components/DailyReportCalendar';

const ctrlCls = 'h-10 bg-white border border-gray-300 rounded-md px-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500';
const rowCls = 'bg-white border-t border-gray-200 hover:bg-gray-100 transition-colors';
const badgeCls = 'inline-block px-2 py-0.5 rounded-full text-xs font-medium';

export default function DailyReportPage() {
  const { lang } = useLang();
  const [selectedDate, setSelectedDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [searchValue, setSearchValue] = useState('');
  const [activeTab, setActiveTab] = useState<'finished' | 'semi'>('finished');
  const [sortConfig, setSortConfig] = useState<{
    key: string;
    direction: 'asc' | 'desc';
  } | null>(null);

  // 훅 사용 - 각 탭별로 별도 데이터 가져오기
  const { data: finishedData, isLoading: finishedLoading, error: finishedError } = useDailyReport({
    date: selectedDate,
    warehouse_code: '',
    material_code: searchValue,
    warehouse_type: 'finished'
  });

  const { data: semiData, isLoading: semiLoading, error: semiError } = useDailyReport({
    date: selectedDate,
    warehouse_code: '',
    material_code: searchValue,
    warehouse_type: 'semi'
  });

  const { data: summaryData } = useDailyReportSummary(selectedDate);
  const { createSnapshot, isCreating } = useCreateSnapshot();

  // 현재 탭에 따른 데이터 선택
  const currentData = activeTab === 'finished' ? finishedData : semiData;
  const currentLoading = activeTab === 'finished' ? finishedLoading : semiLoading;
  const currentError = activeTab === 'finished' ? finishedError : semiError;
  const filteredData = currentData?.results || [];

  // 스냅샷 생성
  const handleCreateSnapshot = async () => {
    try {
      await createSnapshot(selectedDate, false);
      toast.success('스냅샷이 성공적으로 생성되었습니다.');
      // 데이터 새로고침
      window.location.reload();
    } catch (err: any) {
      toast.error(err.message);
    }
  };

  // QC 상태 렌더링
  const renderQcStatus = (qc: string) => {
    if (!qc) return '-';
    const mapping: Record<string, { label: string; color: string }> = {
      '1': { label: '合格', color: 'bg-green-100 text-green-600' },
      '2': { label: '让步合格', color: 'bg-yellow-100 text-yellow-600' },
      '3': { label: '待检', color: 'bg-blue-100 text-blue-600' },
      '4': { label: '不合格', color: 'bg-red-100 text-red-600' },
    };
    const entry = mapping[qc] || { label: qc, color: 'bg-gray-100 text-gray-600' };
    return <span className={`${badgeCls} ${entry.color}`}>{entry.label}</span>;
  };

  // 단위 변환 함수
  const formatUnit = (unit: string | null) => {
    if (!unit) return '-';
    
    // 언어별 단위 변환
    const unitMappings: Record<string, Record<string, string>> = {
      'ko': {
        'UN000': 'EA',
        'KG': 'KG',
        'M': 'M',
        'L': 'L',
        'TON': 'TON',
        'PC': 'PC',
        'SET': 'SET',
        'BOX': 'BOX'
      },
      'zh': {
        'UN000': '个',
        'KG': '公斤',
        'M': '米',
        'L': '升',
        'TON': '吨',
        'PC': '件',
        'SET': '套',
        'BOX': '箱'
      }
    };
    
    const currentLangMappings = unitMappings[lang] || unitMappings['ko'];
    return currentLangMappings[unit] || unit;
  };

  // 수량 포맷팅 (소숫점 1자리, 천단위 콤마)
  const formatQuantity = (value: number | string | null | undefined) => {
    if (value === null || value === undefined) return '-';
    
    // 숫자로 변환
    const numValue = typeof value === 'string' ? parseFloat(value) : value;
    if (isNaN(numValue)) return '-';
    
    return numValue.toLocaleString('ko-KR', { 
      minimumFractionDigits: 1, 
      maximumFractionDigits: 1 
    });
  };

  // 증감 표시 (수량만 표시, 퍼센트 제거)
  const renderChange = (change: number | string | null) => {
    if (change === null) return '-';
    
    // 숫자로 변환
    const numValue = typeof change === 'string' ? parseFloat(change) : change;
    if (isNaN(numValue)) return '-';
    
    const isPositive = numValue > 0;
    const isNegative = numValue < 0;
    const color = isPositive ? 'text-green-600' : isNegative ? 'text-red-600' : 'text-gray-600';
    const sign = isPositive ? '+' : '';
    
    return (
      <div className={`text-sm ${color}`}>
        <div>{sign}{formatQuantity(numValue)}</div>
      </div>
    );
  };

  // 대차 상세 정보 모달
  const [selectedItem, setSelectedItem] = useState<any>(null);
  const [showCartModal, setShowCartModal] = useState(false);

  const openCartModal = (item: any) => {
    setSelectedItem(item);
    setShowCartModal(true);
  };

  // 정렬 함수
  const handleSort = (key: string) => {
    let direction: 'asc' | 'desc' = 'asc';
    if (sortConfig && sortConfig.key === key && sortConfig.direction === 'asc') {
      direction = 'desc';
    }
    setSortConfig({ key, direction });
  };

  // 정렬된 데이터
  const sortedData = useMemo(() => {
    if (!sortConfig) return filteredData;

    return [...filteredData].sort((a, b) => {
      let aValue: any = a[sortConfig.key as keyof typeof a];
      let bValue: any = b[sortConfig.key as keyof typeof b];

      // 숫자 필드 처리
      if (['total_quantity', 'cart_count', 'prev_quantity', 'quantity_change', 'cart_count_change'].includes(sortConfig.key)) {
        aValue = parseFloat(aValue) || 0;
        bValue = parseFloat(bValue) || 0;
      }

      if (aValue < bValue) {
        return sortConfig.direction === 'asc' ? -1 : 1;
      }
      if (aValue > bValue) {
        return sortConfig.direction === 'asc' ? 1 : -1;
      }
      return 0;
    });
  }, [filteredData, sortConfig]);

  // 정렬 아이콘 렌더링
  const renderSortIcon = (key: string) => {
    if (!sortConfig || sortConfig.key !== key) {
      return (
        <div className="inline-flex flex-col ml-2">
          <div className="w-0 h-0 border-l-3 border-r-3 border-b-3 border-transparent border-b-gray-400"></div>
          <div className="w-0 h-0 border-l-3 border-r-3 border-t-3 border-transparent border-t-gray-400 mt-1"></div>
        </div>
      );
    }
    
    if (sortConfig.direction === 'asc') {
      return (
        <div className="inline-flex flex-col ml-2">
          <div className="w-0 h-0 border-l-3 border-r-3 border-b-3 border-transparent border-b-blue-600"></div>
          <div className="w-0 h-0 border-l-3 border-r-3 border-t-3 border-transparent border-t-gray-400 mt-1"></div>
        </div>
      );
    } else {
      return (
        <div className="inline-flex flex-col ml-2">
          <div className="w-0 h-0 border-l-3 border-r-3 border-b-3 border-transparent border-b-gray-400"></div>
          <div className="w-0 h-0 border-l-3 border-r-3 border-t-3 border-transparent border-t-blue-600 mt-1"></div>
        </div>
      );
    }
  };

  return (
    <div className="w-full px-6 py-6 space-y-6">
      {/* 메인 레이아웃: 왼쪽 카드 그리드 + 오른쪽 달력 */}
      <div className="grid grid-cols-1 xl:grid-cols-5 gap-6">
        {/* 왼쪽: 6개 카드를 2열 3행으로 배치 */}
        <div className="xl:col-span-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 h-full">
            {/* 1행 - 총 품목수 */}
            <div className="bg-white p-4 rounded-lg shadow-lg flex flex-col justify-center h-full">
              <h3 className="text-sm font-medium text-gray-600 mb-2">총 품목수</h3>
              {summaryData && (
                <div className="text-2xl font-bold text-blue-600">
                  {summaryData.today.total_items.toLocaleString()}
                </div>
              )}
            </div>

            {/* 1행 - 총 수량 */}
            <div className="bg-white p-4 rounded-lg shadow-lg flex flex-col justify-center h-full">
              <h3 className="text-sm font-medium text-gray-600 mb-2">총 수량</h3>
              {summaryData && (
                <div className="space-y-1">
                  <div className="text-2xl font-bold text-green-600">
                    {formatQuantity(summaryData.today.total_quantity)}
                  </div>
                </div>
              )}
            </div>

            {/* 2행 - 총 사용 带车수 */}
            <div className="bg-white p-4 rounded-lg shadow-lg flex flex-col justify-center h-full">
              <h3 className="text-sm font-medium text-gray-600 mb-2">총 사용 带车수</h3>
              {summaryData && (
                <div className="text-2xl font-bold text-purple-600">
                  {summaryData.today.total_carts.toLocaleString()}
                </div>
              )}
            </div>

            {/* 2행 - 제품창고 수량 */}
            <div className="bg-white p-4 rounded-lg shadow-lg flex flex-col justify-center h-full">
              <h3 className="text-sm font-medium text-gray-600 mb-2">제품창고 수량</h3>
              {summaryData && (
                <div className="text-2xl font-bold text-green-500">
                  {formatQuantity(summaryData.warehouse_summary?.find(w => w.warehouse_name === '成品仓库')?.total_quantity || 0)}
                </div>
              )}
            </div>

            {/* 3행 - 반제품창고 수량 */}
            <div className="bg-white p-4 rounded-lg shadow-lg flex flex-col justify-center h-full">
              <h3 className="text-sm font-medium text-gray-600 mb-2">반제품창고 수량</h3>
              {summaryData && (
                <div className="text-2xl font-bold text-green-400">
                  {formatQuantity(summaryData.warehouse_summary?.find(w => w.warehouse_name === '半成品仓库')?.total_quantity || 0)}
                </div>
              )}
            </div>

            {/* 3행 - 제품창고 带车수 */}
            <div className="bg-white p-4 rounded-lg shadow-lg flex flex-col justify-center h-full">
              <h3 className="text-sm font-medium text-gray-600 mb-2">제품창고 带车수</h3>
              {summaryData && (
                <div className="text-2xl font-bold text-purple-500">
                  {summaryData.warehouse_summary?.find(w => w.warehouse_name === '成品仓库')?.cart_count || 0}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 오른쪽: 달력 */}
        <div className="xl:col-span-2">
          <div className="bg-white p-4 rounded-lg shadow-lg h-fit">
            <DailyReportCalendar 
              onDateSelect={setSelectedDate}
              selectedDate={selectedDate}
            />
          </div>
        </div>
      </div>

      {/* 검색 및 액션 */}
      <div className="flex flex-wrap gap-4 items-center">
        {/* 검색창 */}
        <div className="flex-1 min-w-[300px]">
          <Input
            type="text"
            placeholder="物料编号 / 物料规格"
            value={searchValue}
            onChange={(e) => setSearchValue(e.target.value)}
            className={ctrlCls}
          />
        </div>

        {/* 액션 버튼들 */}
        <div className="flex gap-2">
          <Button 
            onClick={handleCreateSnapshot} 
            disabled={isCreating}
            className="bg-blue-600 hover:bg-blue-700"
          >
            {isCreating ? '생성 중...' : '스냅샷 생성'}
          </Button>
          <Button 
            variant="ghost"
            className="border border-gray-300 hover:bg-gray-50"
          >
            비교하기
          </Button>
        </div>
      </div>

             {/* 탭 및 데이터 테이블 */}
       <div className="bg-white rounded-lg shadow-lg">
        {/* 탭 */}
        <div className="flex justify-between items-center border-b border-gray-200">
          <div className="flex">
            <button
              className={`px-6 py-3 font-medium text-sm border-b-2 transition-colors ${
                activeTab === 'finished'
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
              onClick={() => setActiveTab('finished')}
            >
              成品仓库 ({finishedData?.results?.length || 0})
            </button>
            <button
              className={`px-6 py-3 font-medium text-sm border-b-2 transition-colors ${
                activeTab === 'semi'
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
              onClick={() => setActiveTab('semi')}
            >
              半成品仓库 ({semiData?.results?.length || 0})
            </button>
          </div>
          
          {/* 스냅샷 업데이트 시간 */}
          {'snapshot_created_at' in (currentData || {}) && (currentData as any)?.snapshot_created_at && (
            <div className="px-6 py-3 text-sm text-gray-600">
              스냅샷 업데이트: {format(new Date((currentData as any).snapshot_created_at), 'yyyy-MM-dd HH:mm')}
            </div>
          )}
        </div>

        {/* 테이블 */}
        <div className="overflow-x-auto">
          <table className="w-full table-fixed divide-y divide-gray-200 text-sm">
            <thead className="bg-slate-100 whitespace-nowrap">
               <tr>
                 <th 
                   className="px-3 py-2 text-center cursor-pointer hover:bg-slate-200 transition-colors w-32"
                   onClick={() => handleSort('material_code')}
                 >
                   <div className="flex items-center justify-center">
                     物料编号&nbsp;&nbsp;
                     {renderSortIcon('material_code')}
                   </div>
                 </th>
                 <th 
                   className="px-3 py-2 text-center cursor-pointer hover:bg-slate-200 transition-colors w-40"
                   onClick={() => handleSort('specification')}
                 >
                   <div className="flex items-center justify-center">
                     物料规格&nbsp;&nbsp;
                     {renderSortIcon('specification')}
                   </div>
                 </th>
                 <th 
                   className="px-3 py-2 text-center cursor-pointer hover:bg-slate-200 transition-colors w-24"
                   onClick={() => handleSort('warehouse_name')}
                 >
                   <div className="flex items-center justify-center">
                     仓库&nbsp;&nbsp;
                     {renderSortIcon('warehouse_name')}
                   </div>
                 </th>
                 <th 
                   className="px-3 py-2 text-center cursor-pointer hover:bg-slate-200 transition-colors w-24"
                   onClick={() => handleSort('qc_status')}
                 >
                   <div className="flex items-center justify-center">
                     质量状态&nbsp;&nbsp;
                     {renderSortIcon('qc_status')}
                   </div>
                 </th>
                 <th 
                   className="px-3 py-2 text-center cursor-pointer hover:bg-slate-200 transition-colors w-24"
                   onClick={() => handleSort('total_quantity')}
                 >
                   <div className="flex items-center justify-center">
                     数量&nbsp;&nbsp;
                     {renderSortIcon('total_quantity')}
                   </div>
                 </th>
                 <th 
                   className="px-3 py-2 text-center cursor-pointer hover:bg-slate-200 transition-colors w-16"
                   onClick={() => handleSort('unit')}
                 >
                   <div className="flex items-center justify-center">
                     单位&nbsp;&nbsp;
                     {renderSortIcon('unit')}
                   </div>
                 </th>
                 <th 
                   className="px-3 py-2 text-center cursor-pointer hover:bg-slate-200 transition-colors w-20"
                   onClick={() => handleSort('cart_count')}
                 >
                   <div className="flex items-center justify-center">
                     带车数&nbsp;&nbsp;
                     {renderSortIcon('cart_count')}
                   </div>
                 </th>
                 <th 
                   className="px-3 py-2 text-center cursor-pointer hover:bg-slate-200 transition-colors w-24"
                   onClick={() => handleSort('prev_quantity')}
                 >
                   <div className="flex items-center justify-center">
                     前日数量&nbsp;&nbsp;
                     {renderSortIcon('prev_quantity')}
                   </div>
                 </th>
                 <th 
                   className="px-3 py-2 text-center cursor-pointer hover:bg-slate-200 transition-colors w-24"
                   onClick={() => handleSort('quantity_change')}
                 >
                   <div className="flex items-center justify-center">
                     数量变化&nbsp;&nbsp;
                     {renderSortIcon('quantity_change')}
                   </div>
                 </th>
                 <th 
                   className="px-3 py-2 text-center cursor-pointer hover:bg-slate-200 transition-colors w-20"
                   onClick={() => handleSort('cart_count_change')}
                 >
                   <div className="flex items-center justify-center">
                     带车变化&nbsp;&nbsp;
                     {renderSortIcon('cart_count_change')}
                   </div>
                 </th>
                 <th className="px-3 py-2 text-center w-16">详情</th>
               </tr>
             </thead>
            <tbody>
                           {currentLoading ? (
               <tr>
                 <td colSpan={11} className="text-center py-4">
                   로딩 중...
                 </td>
               </tr>
             ) : currentError ? (
               <tr>
                 <td colSpan={11} className="text-center py-4 text-red-600">
                   {currentError}
                 </td>
               </tr>
             ) : filteredData.length === 0 ? (
                <tr>
                  <td colSpan={11} className="text-center py-4 text-gray-500">
                    데이터가 없습니다.
                  </td>
                </tr>
                             ) : (
                 sortedData.map((item, index) => (
                  <tr key={`${item.material_code}_${item.warehouse_code}_${item.qc_status}_${index}`} className={rowCls}>
                    <td className="px-3 py-2 text-center font-medium">{item.material_code}</td>
                    <td className="px-3 py-2 text-center">{item.specification || '-'}</td>
                    <td className="px-3 py-2 text-center">{item.warehouse_name}</td>
                    <td className="px-3 py-2 text-center">{renderQcStatus(item.qc_status)}</td>
                    <td className="px-3 py-2 text-right font-semibold">
                      {formatQuantity(item.total_quantity)}
                    </td>
                    <td className="px-3 py-2 text-center">{formatUnit(item.unit)}</td>
                    <td className="px-3 py-2 text-center">{item.cart_count}</td>
                    <td className="px-3 py-2 text-right">
                      {formatQuantity(item.prev_quantity)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {renderChange(item.quantity_change)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {renderChange(item.cart_count_change)}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => openCartModal(item)}
                        className="h-8 px-2 text-xs border border-gray-300"
                      >
                        查看
                      </Button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* 대차 상세 정보 모달 */}
      {showCartModal && selectedItem && (
        <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-4xl w-full mx-4 max-h-[80vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-semibold">
                {selectedItem.material_code} - {selectedItem.warehouse_name} 带车 상세
              </h3>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowCartModal(false)}
                className="h-8 px-3 border border-gray-300"
              >
                닫기
              </Button>
            </div>
            
            <div className="space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                <div>
                  <span className="font-medium">物料编号:</span> {selectedItem.material_code}
                </div>
                <div>
                  <span className="font-medium">物料规格:</span> {selectedItem.specification || '-'}
                </div>
                <div>
                  <span className="font-medium">仓库:</span> {selectedItem.warehouse_name}
                </div>
                <div>
                  <span className="font-medium">质量状态:</span> {renderQcStatus(selectedItem.qc_status)}
                </div>
              </div>
              
              <div className="border-t pt-4">
                <h4 className="font-medium mb-2">带车 상세 정보 ({selectedItem.cart_details.length}개)</h4>
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-200 text-sm">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-3 py-2 text-left">标识码</th>
                        <th className="px-3 py-2 text-left">标签码</th>
                        <th className="px-3 py-2 text-right">数量</th>
                        <th className="px-3 py-2 text-left">位置</th>
                        <th className="px-3 py-2 text-left">工单编号</th>
                        <th className="px-3 py-2 text-left">更新时间</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedItem.cart_details.map((cart: any, index: number) => (
                        <tr key={index} className="border-t border-gray-100">
                          <td className="px-3 py-2">{cart.qr_code || '-'}</td>
                          <td className="px-3 py-2">{cart.label_code || '-'}</td>
                          <td className="px-3 py-2 text-right font-medium">
                            {formatQuantity(cart.quantity)}
                          </td>
                          <td className="px-3 py-2">{cart.location_name || '-'}</td>
                          <td className="px-3 py-2">{cart.work_order_code || '-'}</td>
                          <td className="px-3 py-2">
                            {cart.updated_at ? format(new Date(cart.updated_at), 'yyyy-MM-dd HH:mm') : '-'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}