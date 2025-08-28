import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useInventoryStatus } from '../../hooks/useInventoryStatus';
import { useWarehouses } from '../../hooks/useWarehouses';
import { useLastUpdate } from '../../hooks/useLastUpdate';
import { Button } from '../../components/ui/button';
import PermissionButton from '../../components/common/PermissionButton';
import { Input } from '../../components/ui/input';
import { toast } from 'react-toastify';
import api from '../../lib/api';
import { format } from 'date-fns';

const ctrlCls =
  'h-10 bg-white border border-gray-300 rounded-md px-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500';
const rowCls =
  'bg-white border-t border-gray-200 hover:bg-gray-100 transition-colors';
const badgeCls = 'inline-block px-2 py-0.5 rounded-full text-xs font-medium';

export default function InventoryStatusPage() {
  const queryClient = useQueryClient();
  const [params, setParams] = useState<Record<string, any>>({ 
    page: 1, 
    size: 100,
    updated_at__gte: '',
    updated_at__lte: ''
  });
  const [sortField, setSortField] = useState<string>('');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  const { data, isLoading } = useInventoryStatus(params);
  const { data: warehouses = [] } = useWarehouses();
  const { data: lastUpdate } = useLastUpdate();

  /* ---------- inventory refresh ---------- */
  const [updating, setUpdating] = useState(false);
  const [progress, setProgress] = useState<{
    current: number;
    total: number;
    status: string;
    page?: number;
  }>({ current: 0, total: 0, status: 'idle' });

  const refreshInventory = async () => {
    if (updating) return;
    setUpdating(true);
    setProgress({ current: 0, total: 0, status: 'starting' });
    
    try {
      // 업데이트 시작
      await api.post('/mes/inventory/refresh/');
      
      // 진행 상황 폴링
      const pollInterval = setInterval(async () => {
        try {
          const response = await api.get('/mes/inventory/refresh/');
          setProgress(response.data);
          
          if (response.data.status === 'completed') {
            clearInterval(pollInterval);
            setUpdating(false);
            toast.success(`재고 업데이트 완료: ${response.data.total}개 항목`);
            setProgress({ current: 0, total: 0, status: 'idle' });
            
            // 재고 업데이트 완료 후 관련 쿼리들을 무효화하여 데이터 다시 가져오기
            queryClient.invalidateQueries({ queryKey: ['inventories'] });
            queryClient.invalidateQueries({ queryKey: ['lastUpdate'] });
          } else if (response.data.status === 'error') {
            clearInterval(pollInterval);
            setUpdating(false);
            toast.error(`재고 업데이트 실패: ${response.data.error || '알 수 없는 오류'}`);
            setProgress({ current: 0, total: 0, status: 'idle' });
          }
        } catch (err) {
          console.error('Progress poll error:', err);
        }
      }, 1000); // 1초마다 폴링
      
    } catch (err: any) {
      toast.error('재고 업데이트 실패');
      setUpdating(false);
      setProgress({ current: 0, total: 0, status: 'idle' });
    }
  };

  /* ---------- warehouse dropdown ---------- */
  const [selectedWarehouses, setSelectedWarehouses] = useState<string[]>([]);
  const [openDropdown, setOpenDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const toggleWarehouse = (code: string) => {
    setSelectedWarehouses((prev) => {
      let next: string[];
      if (code === '__ALL__') {
        next = [];
      } else {
        next = prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code];
      }
      setParams((p) => ({
        ...p,
        warehouse_code__in: next.length ? next.join(',') : undefined,
        page: 1,
      }));
      return next;
    });
  };
  // close dropdown on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpenDropdown(false);
      }
    };
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, []);
  const allSelected = selectedWarehouses.length === 0;
  const selectedLabel = allSelected
    ? '전체'
    : warehouses
        .filter((w) => selectedWarehouses.includes(w.warehouse_code))
        .map((w) => w.warehouse_name)
        .slice(0, 2)
        .join(', ') + (selectedWarehouses.length > 2 ? ` 외 ${selectedWarehouses.length - 2}` : '');

  /* ---------- search ---------- */
  const [searchValue, setSearchValue] = useState('');
  
  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setSearchValue(value);
    // 즉시 검색 실행
    setParams((p) => ({ ...p, search: value || undefined, page: 1 }));
  };

  // 검색값 초기화 함수
  const clearSearch = () => {
    setSearchValue('');
    setParams((p) => ({ ...p, search: undefined, page: 1 }));
  };

  // params.search가 외부에서 변경될 때 searchValue 동기화
  useEffect(() => {
    setSearchValue(params.search || '');
  }, [params.search]);

  // 검색 입력 필드에 X 버튼 추가
  const handleClearSearch = () => {
    clearSearch();
  };

  /* ---------- date filters ---------- */
  const handleDateChange = (field: 'updated_at__gte' | 'updated_at__lte', value: string) => {
    let dateValue = undefined;
    if (value) {
      if (field === 'updated_at__gte') {
        // 시작 날짜: 00:00:00
        dateValue = `${value}T00:00:00`;
      } else {
        // 종료 날짜: 23:59:59
        dateValue = `${value}T23:59:59`;
      }
    }
    setParams((p) => ({ 
      ...p, 
      [field]: dateValue, 
      page: 1 
    }));
  };

  /* ---------- CSV download ---------- */
  const downloadCSV = async () => {
    try {
      // 현재 필터링된 데이터를 CSV로 다운로드
      const response = await api.get('/mes/inventory/export/', { 
        params: { 
          ...params, 
          size: 10000, // 최대 10000개까지 다운로드
          // 정렬 파라미터도 포함
          sort_field: sortField,
          sort_order: sortOrder
        },
        responseType: 'blob' // CSV 파일을 blob으로 받기
      });
      
      // CSV 파일 생성 및 다운로드
      const blob = new Blob([response.data], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement('a');
      const url = URL.createObjectURL(blob);
      link.setAttribute('href', url);
      link.setAttribute('download', `inventory_${format(new Date(), 'yyyy-MM-dd_HH-mm')}.csv`);
      link.style.visibility = 'hidden';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url); // 메모리 정리
      
      toast.success('CSV 다운로드 완료');
    } catch (err: any) {
      console.error('CSV download error:', err);
      toast.error('CSV 다운로드 실패');
    }
  };

  /* ---------- sorting ---------- */
  const handleSort = (field: string) => {
    if (sortField === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortOrder('asc');
    }
    
    // 백엔드에 정렬 파라미터 전달
    setParams(prev => ({
      ...prev,
      sort_field: field,
      sort_order: sortField === field ? (sortOrder === 'asc' ? 'desc' : 'asc') : 'asc',
      page: 1
    }));
  };

  /* ---------- helpers ---------- */
  const renderQcStatus = (qc: any) => {
    if (qc === null || qc === undefined || qc === '') return '-';
    const code = String(qc);
    const mapping: Record<string,{label:string;color:string}> = {
      '1': { label: '合格', color: 'bg-green-100 text-green-600' },
      '2': { label: '让步合格', color: 'bg-yellow-100 text-yellow-600' },
      '3': { label: '待检', color: 'bg-blue-100 text-blue-600' },
      '4': { label: '不合格', color: 'bg-red-100 text-red-600' },
    };
    const entry = mapping[code] || { label: String(qc), color: 'bg-gray-100 text-gray-600' };
    return <span className={`${badgeCls} ${entry.color}`}>{entry.label}</span>;
  };

  // 정렬 아이콘 렌더링
  const renderSortIcon = (field: string) => {
    if (sortField !== field) {
      return (
        <div className="inline-flex flex-col ml-2">
          <div className="w-0 h-0 border-l-3 border-r-3 border-b-3 border-transparent border-b-gray-400"></div>
          <div className="w-0 h-0 border-l-3 border-r-3 border-t-3 border-transparent border-t-gray-400 mt-1"></div>
        </div>
      );
    }
    
    if (sortOrder === 'asc') {
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

  /* ---------- render ---------- */
  return (
    <div className="w-full px-6 py-6 space-y-4">
      <h1 className="text-2xl font-bold mb-2">재고 상세 현황</h1>

      {/* Filters */}
      <div className="flex flex-wrap gap-4 items-start relative">
        {/* warehouse dropdown */}
        <div className="relative" ref={dropdownRef}>
          <label className="block text-sm font-medium mb-1">창고</label>
          <button
            type="button"
            onClick={() => setOpenDropdown((o) => !o)}
            className={ctrlCls + ' min-w-[180px] flex justify-between items-center'}
          >
            <span className="truncate text-left">{selectedLabel}</span>
            <svg
              className="w-4 h-4 ml-2 text-gray-400"
              viewBox="0 0 20 20"
              fill="currentColor"
            >
              <path
                fillRule="evenodd"
                d="M5.23 7.21a.75.75 0 011.06.02L10 11.292l3.71-4.06a.75.75 0 111.08 1.04l-4.24 4.63a.75.75 0 01-1.08 0L5.25 8.27a.75.75 0 01-.02-1.06z"
                clipRule="evenodd"
              />
            </svg>
          </button>
          {openDropdown && (
            <div className="absolute z-20 mt-1 w-60 max-h-48 overflow-y-auto rounded-md border border-gray-300 bg-white shadow-lg p-2 space-y-1">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  className="accent-blue-600"
                  checked={allSelected}
                  onChange={() => toggleWarehouse('__ALL__')}
                />
                전체
              </label>
              {warehouses.map((w) => (
                <label key={w.warehouse_code} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="accent-blue-600"
                    checked={selectedWarehouses.includes(w.warehouse_code)}
                    onChange={() => toggleWarehouse(w.warehouse_code)}
                  />
                  {w.warehouse_name}
                </label>
              ))}
            </div>
          )}
        </div>

        {/* QC status filter */}
        <div>
          <label className="block text-sm font-medium mb-1">质量状态</label>
          <select
            className={ctrlCls + ' min-w-[120px]'}
            value={params.qc_status || ''}
            onChange={(e) => setParams((p) => ({ ...p, qc_status: e.target.value || undefined, page: 1 }))}
          >
            <option value="">全部</option>
            <option value="1">合格</option>
            <option value="2">让步合格</option>
            <option value="3">待检</option>
            <option value="4">不合格</option>
          </select>
        </div>


        {/* date range filters */}
        <div>
          <label className="block text-sm font-medium mb-1">开始日期</label>
          <input
            type="date"
            className={ctrlCls + ' min-w-[140px]'}
            value={params.updated_at__gte ? params.updated_at__gte.split('T')[0] : ''}
            onChange={(e) => handleDateChange('updated_at__gte', e.target.value)}
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">结束日期</label>
          <input
            type="date"
            className={ctrlCls + ' min-w-[140px]'}
            value={params.updated_at__lte ? params.updated_at__lte.split('T')[0] : ''}
            onChange={(e) => handleDateChange('updated_at__lte', e.target.value)}
          />
        </div>

        {/* unified search input */}
        <div className="flex-1 min-w-[220px]">
          <label className="block text-sm font-medium mb-1">검색</label>
          <div className="relative">
            <Input
              type="text"
              placeholder="标识码 / 物料编号 / 物料规格"
              value={searchValue}
              onChange={handleSearchChange}
              className={ctrlCls}
            />
            {searchValue && (
              <button
                type="button"
                onClick={handleClearSearch}
                className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-600"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        </div>

        {/* action buttons */}
        <div className="flex flex-col items-end gap-2">
          {/* 최근 업데이트 시간 */}
          {lastUpdate?.last_update ? (
            <div className="text-xs text-gray-500 text-right">
              최근 업데이트: {format(new Date(lastUpdate.last_update), 'yyyy-MM-dd HH:mm:ss')}
            </div>
          ) : (
            <div className="text-xs text-gray-400 text-right">
              업데이트 정보 로딩 중...
            </div>
          )}
          <div className="flex gap-2">
            <PermissionButton 
              permission="can_edit_inventory" 
              onClick={refreshInventory} 
              className={`inline-flex items-center justify-center gap-1 h-10 px-4 rounded-xl bg-blue-600 text-white hover:bg-blue-700 font-semibold text-base ${updating ? 'opacity-60 cursor-not-allowed' : ''}`}
              disabled={updating}
            >
            {updating && (
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                ></circle>
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z"
                />
              </svg>
            )}
            재고 업데이트
            </PermissionButton>
          <Button onClick={downloadCSV} className="flex items-center gap-1 h-10 bg-green-600 hover:bg-green-700">
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            CSV 다운로드
          </Button>
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg shadow-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-slate-100 whitespace-nowrap">
            <tr>
              <th 
                className="px-3 py-2 text-center cursor-pointer hover:bg-slate-200 transition-colors"
                onClick={() => handleSort('updated_at')}
              >
                <div className="flex items-center justify-center">
                  更新时间&nbsp;&nbsp;
                  {renderSortIcon('updated_at')}
                </div>
              </th>
              <th 
                className="px-3 py-2 text-center cursor-pointer hover:bg-slate-200 transition-colors"
                onClick={() => handleSort('qr_code')}
              >
                <div className="flex items-center justify-center">
                  标识码&nbsp;&nbsp;
                  {renderSortIcon('qr_code')}
                </div>
              </th>
              <th 
                className="px-3 py-2 text-center cursor-pointer hover:bg-slate-200 transition-colors"
                onClick={() => handleSort('material_code')}
              >
                <div className="flex items-center justify-center">
                  物料编号&nbsp;&nbsp;
                  {renderSortIcon('material_code')}
                </div>
              </th>
              <th 
                className="px-3 py-2 text-center cursor-pointer hover:bg-slate-200 transition-colors"
                onClick={() => handleSort('specification')}
              >
                <div className="flex items-center justify-center">
                  物料规格&nbsp;&nbsp;
                  {renderSortIcon('specification')}
                </div>
              </th>
              <th 
                className="px-3 py-2 text-center w-24 cursor-pointer hover:bg-slate-200 transition-colors"
                onClick={() => handleSort('quantity')}
              >
                <div className="flex items-center justify-center">
                  数量&nbsp;&nbsp;
                  {renderSortIcon('quantity')}
                </div>
              </th>
              <th 
                className="px-3 py-2 text-center cursor-pointer hover:bg-slate-200 transition-colors"
                onClick={() => handleSort('warehouse_name')}
              >
                <div className="flex items-center justify-center">
                  仓库&nbsp;&nbsp;
                  {renderSortIcon('warehouse_name')}
                </div>
              </th>
              <th 
                className="px-3 py-2 text-center cursor-pointer hover:bg-slate-200 transition-colors"
                onClick={() => handleSort('qc_status')}
              >
                <div className="flex items-center justify-center">
                  质量状态&nbsp;&nbsp;
                  {renderSortIcon('qc_status')}
                </div>
              </th>
              <th 
                className="px-3 py-2 text-center cursor-pointer hover:bg-slate-200 transition-colors"
                onClick={() => handleSort('work_order_code')}
              >
                <div className="flex items-center justify-center">
                  生产工单编号&nbsp;&nbsp;
                  {renderSortIcon('work_order_code')}
                </div>
              </th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={8} className="text-center py-4">
                  Loading...
                </td>
              </tr>
            ) : (
              data?.results?.map((row, index) => {
                const qr = (row as any).qr_code || (row as any).label_code || row.material_id;
                // 고유한 키 생성: material_id + warehouse_code + qc_status + index로 중복 방지
                const uniqueKey = `${row.material_id}_${row.warehouse_code}_${(row as any).qc_status || 'null'}_${index}`;
                return (
                  <tr key={uniqueKey} className={`${rowCls} whitespace-nowrap`}>
                    <td className="px-3 py-2 text-center">
                      {format(new Date(row.updated_at), 'yyyy-MM-dd HH:mm')}
                    </td>
                    <td className="px-3 py-2 text-center">{qr}</td>
                    <td className="px-3 py-2 text-center">{row.material_code}</td>
                    <td className="px-3 py-2 text-center">{(row as any).specification || '-'}</td>
                    <td className="px-3 py-2 text-right w-24 ">
                      {Number(row.quantity).toLocaleString(undefined, {
                        minimumFractionDigits: 1,
                        maximumFractionDigits: 1,
                      })}
                    </td>
                    <td className="px-3 py-2 text-center">{row.warehouse_name}</td>
                    <td className="px-3 py-2 text-center">{renderQcStatus((row as any).qc_status)}</td>
                    <td className="px-3 py-2 text-center">{(row as any).work_order_code || '-'}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
        </div>
      </div>

      {/* Pagination */}
      {data && (
        <div className="flex justify-between items-center pt-4">
          <span className="text-sm text-gray-600">
            총 {(data.total ?? 0).toLocaleString()} 건
          </span>
          <div className="flex gap-2 items-center">
            <Button
              variant="ghost"
              size="sm"
              disabled={params.page === 1}
              onClick={() => setParams((p) => ({ ...p, page: (p.page || 1) - 1 }))}
            >
              이전
            </Button>
            <span className="text-sm">
              {params.page} / {Math.ceil((data.total ?? 0) / (params.size || 100))}
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={(params.page || 1) >= Math.ceil((data.total ?? 0) / (params.size || 100))}
              onClick={() => setParams((p) => ({ ...p, page: (p.page || 1) + 1 }))}
            >
              다음
            </Button>
          </div>
        </div>
      )}

      {/* Progress Modal */}
      {updating && progress.status !== 'idle' && (
        <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-gray-900">재고 업데이트 진행 중</h3>
              <div className="animate-spin h-6 w-6 border-2 border-blue-600 border-t-transparent rounded-full"></div>
            </div>
            
            <div className="space-y-3">
              <div className="text-sm text-gray-600">
                {progress.status === 'initializing' && '초기화 중...'}
                {progress.status === 'fetching' && (
                  <div className="space-y-2">
                    <div>페이지 {progress.page} 처리 중...</div>
                    <div className="font-semibold text-blue-600">
                      총 {progress.total.toLocaleString()} 항목 처리됨
                    </div>
                  </div>
                )}
                {progress.status === 'starting' && '업데이트 시작 중...'}
              </div>
              
              {progress.status === 'fetching' && (
                <div className="w-full bg-gray-200 rounded-full h-2">
                  <div 
                    className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                    style={{ 
                      width: progress.total > 0 
                        ? `${Math.min((progress.current / progress.total) * 100, 100)}%` 
                        : '0%' 
                    }}
                  />
                </div>
              )}
              
              <div className="text-xs text-gray-500 mt-2">
                업데이트가 완료될 때까지 잠시 기다려주세요...
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
