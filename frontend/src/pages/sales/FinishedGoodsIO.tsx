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
      <div className="bg-[var(--wj-surface-solid)] rounded-lg border border-[var(--wj-border)] p-4 shadow-sm">
        <p className="text-xs text-[var(--wj-muted)] mb-1">{t('finished_goods_io_summary_slot')}</p>
        <p className="text-lg font-semibold">{snapshot.slot_display}</p>
        <p className="text-xs text-[var(--wj-muted)] mt-2">{t('finished_goods_io_summary_window')}</p>
        <p className="text-sm text-[var(--wj-text)]">
          {formatDate(snapshot.range_start)} ~ {formatDate(snapshot.range_end)}
        </p>
      </div>
      <div className="bg-[var(--wj-surface-solid)] rounded-lg border border-[var(--wj-border)] p-4 shadow-sm">
        <p className="text-xs text-[var(--wj-muted)] mb-1">{t('finished_goods_io_record_count')}</p>
        <p className="text-lg font-semibold">{snapshot.record_count.toLocaleString()}</p>
        <p className="text-xs text-[var(--wj-muted)] mt-3">{t('finished_goods_io_total_in')}</p>
        <p className="text-sm text-[var(--wj-text)]">{formatNumber(snapshot.total_in)}</p>
      </div>
      <div className="bg-[var(--wj-surface-solid)] rounded-lg border border-[var(--wj-border)] p-4 shadow-sm">
        <p className="text-xs text-[var(--wj-muted)] mb-1">{t('finished_goods_io_total_out')}</p>
        <p className="text-lg font-semibold">{formatNumber(snapshot.total_out)}</p>
        <p className="text-xs text-[var(--wj-muted)] mt-3">{t('finished_goods_io_net_change')}</p>
        <p
          className={`text-sm font-semibold ${
            snapshot.net_change >= 0 ? 'text-[var(--wj-success)]' : 'text-[var(--wj-danger)]'
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
        <h1 className="text-2xl font-semibold text-[var(--wj-text)]">{t('finished_goods_io_title')}</h1>
        <p className="text-sm text-[var(--wj-muted)] mt-1">{t('finished_goods_io_description')}</p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-md border border-[var(--wj-border)] bg-[var(--wj-surface-solid)] p-1">
          {slotOrder.map((slot) => (
            <button
              key={slot}
              type="button"
              className={`px-4 py-2 text-sm font-medium rounded-md transition ${
                selectedSlot === slot ? 'bg-[var(--wj-surface-solid)] shadow border border-[var(--wj-border)]' : 'text-[var(--wj-muted)]'
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
        <div className="bg-[var(--wj-surface-solid)] border border-[var(--wj-border)] rounded-lg p-6 text-center text-[var(--wj-muted)]">
          {t('loading')}
        </div>
      ) : !snapshot ? (
        <div className="bg-[var(--wj-surface-solid)] border border-[var(--wj-border)] rounded-lg p-6 text-center text-[var(--wj-muted)]">
          {t('finished_goods_io_no_data')}
        </div>
      ) : (
        <>
          <SummaryCard snapshot={snapshot} t={t} />

          <div className="bg-[var(--wj-surface-solid)] border border-[var(--wj-border)] rounded-lg shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-[var(--wj-border)]">
                <thead className="bg-[var(--wj-surface-solid)] text-xs uppercase tracking-wide text-[var(--wj-muted)]">
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
                <tbody className="divide-y divide-[var(--wj-border)] text-sm">
                  {rows.length === 0 ? (
                    <tr>
                      <td className="px-4 py-6 text-center text-[var(--wj-muted)]" colSpan={10}>
                        {t('finished_goods_io_no_data')}
                      </td>
                    </tr>
                  ) : (
                    rows.map((row) => (
                      <tr key={row.id} className="hover:bg-[var(--wj-surface-solid)] transition">
                        <td className="px-4 py-2 font-medium text-[var(--wj-text)]">{row.material_code}</td>
                        <td className="px-4 py-2 text-[var(--wj-text)]">{row.material_name}</td>
                        <td className="px-4 py-2 text-[var(--wj-muted)]">{row.specification || '-'}</td>
                        <td className="px-4 py-2 text-right font-medium text-[var(--wj-success)]">
                          {formatNumber(row.total_in)}
                        </td>
                        <td className="px-4 py-2 text-right font-medium text-[var(--wj-danger)]">
                          {formatNumber(row.total_out)}
                        </td>
                        <td
                          className={`px-4 py-2 text-right font-semibold ${
                            row.net_change >= 0 ? 'text-[var(--wj-success)]' : 'text-[var(--wj-danger)]'
                          }`}
                        >
                          {formatNumber(row.net_change)}
                        </td>
                        <td className="px-4 py-2 text-center text-[var(--wj-muted)]">{row.unit || '-'}</td>
                        <td className="px-4 py-2 text-center text-[var(--wj-muted)]">
                          {row.record_count.toLocaleString()}
                        </td>
                        <td className="px-4 py-2 text-center text-[var(--wj-muted)]">{formatDate(row.last_in_time)}</td>
                        <td className="px-4 py-2 text-center text-[var(--wj-muted)]">{formatDate(row.last_out_time)}</td>
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
