import { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { Button } from '../../components/ui/button';
import { useLang } from '../../i18n';
import {
  useFinishedGoodsSnapshots,
  useRefreshFinishedGoodsSnapshot,
} from '../../hooks/useFinishedGoodsSnapshots';
import type {
  FinishedGoodsSnapshot,
  FinishedGoodsTransactionRow,
} from '../../hooks/useFinishedGoodsSnapshots';
import { toast } from 'react-toastify';

type SlotType = 'morning' | 'evening';

const slotOrder: SlotType[] = ['morning', 'evening'];

function formatDate(value?: string | null) {
  if (!value) return '-';
  try {
    return format(new Date(value), 'yyyy-MM-dd HH:mm');
  } catch {
    return value;
  }
}

function formatNumber(value?: number | null) {
  if (value === null || value === undefined) return '-';
  return Number(value).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  });
}

const SummaryCard = ({ snapshot, t }: { snapshot: FinishedGoodsSnapshot; t: (key: string) => string }) => {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      <div className="bg-white rounded-lg border border-gray-200 p-4 shadow-sm">
        <p className="text-xs text-gray-500 mb-1">{t('finished_goods_io_summary_slot')}</p>
        <p className="text-lg font-semibold">{snapshot.slot_display}</p>
        <p className="text-xs text-gray-500 mt-2">{t('finished_goods_io_summary_window')}</p>
        <p className="text-sm text-gray-700">
          {formatDate(snapshot.range_start)} ~ {formatDate(snapshot.range_end)}
        </p>
      </div>
      <div className="bg-white rounded-lg border border-gray-200 p-4 shadow-sm">
        <p className="text-xs text-gray-500 mb-1">{t('finished_goods_io_record_count')}</p>
        <p className="text-lg font-semibold">{snapshot.record_count.toLocaleString()}</p>
        <p className="text-xs text-gray-500 mt-3">{t('finished_goods_io_total_in')}</p>
        <p className="text-sm text-gray-700">{formatNumber(snapshot.total_in)}</p>
      </div>
      <div className="bg-white rounded-lg border border-gray-200 p-4 shadow-sm">
        <p className="text-xs text-gray-500 mb-1">{t('finished_goods_io_total_out')}</p>
        <p className="text-lg font-semibold">{formatNumber(snapshot.total_out)}</p>
        <p className="text-xs text-gray-500 mt-3">{t('finished_goods_io_net_change')}</p>
        <p
          className={`text-sm font-semibold ${
            snapshot.net_change >= 0 ? 'text-green-600' : 'text-red-600'
          }`}
        >
          {formatNumber(snapshot.net_change)}
        </p>
      </div>
    </div>
  );
};

export default function FinishedGoodsIOPage() {
  const { t } = useLang();
  const [selectedSlot, setSelectedSlot] = useState<SlotType>('morning');
  const { data, isLoading } = useFinishedGoodsSnapshots({ latest_per_slot: 1 });
  const refreshMutation = useRefreshFinishedGoodsSnapshot();

  useEffect(() => {
    if (!data) return;
    if (data[selectedSlot]) return;
    const fallback = slotOrder.find((slot) => data[slot]);
    if (fallback) {
      setSelectedSlot(fallback);
    }
  }, [data, selectedSlot]);

  const snapshot = useMemo<FinishedGoodsSnapshot | null>(() => {
    if (!data) return null;
    return data[selectedSlot] || null;
  }, [data, selectedSlot]);

  const handleRefresh = async () => {
    try {
      await refreshMutation.mutateAsync({ slot: selectedSlot, force: true });
      toast.success(t('finished_goods_io_refresh_success'));
    } catch (error) {
      console.error(error);
      toast.error(t('finished_goods_io_refresh_error'));
    }
  };

  const rows: FinishedGoodsTransactionRow[] = snapshot?.transactions ?? [];

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">{t('finished_goods_io_title')}</h1>
        <p className="text-sm text-gray-600 mt-1">{t('finished_goods_io_description')}</p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-md border border-gray-200 bg-gray-50 p-1">
          {slotOrder.map((slot) => (
            <button
              key={slot}
              type="button"
              className={`px-4 py-2 text-sm font-medium rounded-md transition ${
                selectedSlot === slot ? 'bg-white shadow border border-gray-200' : 'text-gray-500'
              }`}
              onClick={() => setSelectedSlot(slot)}
            >
              {slot === 'morning' ? t('finished_goods_io_morning') : t('finished_goods_io_evening')}
            </button>
          ))}
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={handleRefresh}
          disabled={refreshMutation.isPending}
        >
          {refreshMutation.isPending ? t('finished_goods_io_refreshing') : t('finished_goods_io_refresh')}
        </Button>
      </div>

      {isLoading ? (
        <div className="bg-white border border-gray-200 rounded-lg p-6 text-center text-gray-500">
          {t('loading')}
        </div>
      ) : !snapshot ? (
        <div className="bg-white border border-gray-200 rounded-lg p-6 text-center text-gray-500">
          {t('finished_goods_io_no_data')}
        </div>
      ) : (
        <>
          <SummaryCard snapshot={snapshot} t={t} />

          <div className="bg-white border border-gray-200 rounded-lg shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-600">
                  <tr>
                    <th className="px-4 py-2 text-left">{t('finished_goods_io_col_material_code')}</th>
                    <th className="px-4 py-2 text-left">{t('finished_goods_io_col_material_name')}</th>
                    <th className="px-4 py-2 text-left">{t('finished_goods_io_col_spec')}</th>
                    <th className="px-4 py-2 text-right">{t('finished_goods_io_col_total_in')}</th>
                    <th className="px-4 py-2 text-right">{t('finished_goods_io_col_total_out')}</th>
                    <th className="px-4 py-2 text-right">{t('finished_goods_io_col_net_change')}</th>
                    <th className="px-4 py-2 text-center">{t('finished_goods_io_col_unit')}</th>
                    <th className="px-4 py-2 text-center">{t('finished_goods_io_col_records')}</th>
                    <th className="px-4 py-2 text-center">{t('finished_goods_io_col_last_in')}</th>
                    <th className="px-4 py-2 text-center">{t('finished_goods_io_col_last_out')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 text-sm">
                  {rows.length === 0 ? (
                    <tr>
                      <td className="px-4 py-6 text-center text-gray-500" colSpan={10}>
                        {t('finished_goods_io_no_data')}
                      </td>
                    </tr>
                  ) : (
                    rows.map((row) => (
                      <tr key={row.id} className="hover:bg-gray-50 transition">
                        <td className="px-4 py-2 font-medium text-gray-900">{row.material_code}</td>
                        <td className="px-4 py-2 text-gray-700">{row.material_name}</td>
                        <td className="px-4 py-2 text-gray-600">{row.specification || '-'}</td>
                        <td className="px-4 py-2 text-right font-medium text-green-700">
                          {formatNumber(row.total_in)}
                        </td>
                        <td className="px-4 py-2 text-right font-medium text-red-600">
                          {formatNumber(row.total_out)}
                        </td>
                        <td
                          className={`px-4 py-2 text-right font-semibold ${
                            row.net_change >= 0 ? 'text-green-700' : 'text-red-600'
                          }`}
                        >
                          {formatNumber(row.net_change)}
                        </td>
                        <td className="px-4 py-2 text-center text-gray-600">{row.unit || '-'}</td>
                        <td className="px-4 py-2 text-center text-gray-600">
                          {row.record_count.toLocaleString()}
                        </td>
                        <td className="px-4 py-2 text-center text-gray-600">{formatDate(row.last_in_time)}</td>
                        <td className="px-4 py-2 text-center text-gray-600">{formatDate(row.last_out_time)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
