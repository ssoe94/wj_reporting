import type { MouldBoard, MouldRecord } from "./api";

const EXPORT_LABELS = {
  ko: {
    sheet: "금형 목록", asset: "자산코드", drawing: "도면번호", model: "모델",
    shots: "최종 누적 Shot 수", location: "현재 위치", unknown: "미확인",
    movement: "마지막 이동 기록 기준", repair: "수리중",
  },
  zh: {
    sheet: "模具清单", asset: "资产编号", drawing: "图号", model: "机型",
    shots: "最终累计 Shot 数", location: "当前位置", unknown: "未确认",
    movement: "按最后移动记录", repair: "维修中",
  },
};

type Language = keyof typeof EXPORT_LABELS;
type ExportRow = [string, string, string, number | null, string];

function exportLocation(mould: MouldRecord, copy: typeof EXPORT_LABELS.ko): string {
  const { inventory, location } = mould;
  if (inventory?.site === "SVC") return ["SVC", ...inventory.sourceLocations].join(" / ");
  if (inventory?.vendor) {
    const qualifiers = [
      inventory.vendor.category === "repair" ? copy.repair : "",
      inventory.basis === "last_movement" ? copy.movement : "",
    ].filter(Boolean);
    return qualifiers.length ? `${inventory.vendor.name} (${qualifiers.join(" · ")})` : inventory.vendor.name;
  }
  const recorded = location.code || location.label;
  if (inventory?.site === "UNCONFIRMED") return recorded ? `${copy.unknown} (${recorded})` : copy.unknown;
  return recorded || copy.unknown;
}

export function mouldExportRows(board: MouldBoard, language: Language): (string | number | null)[][] {
  const copy = EXPORT_LABELS[language];
  const knownAssets = new Set(board.moulds.map((mould) => mould.assetCode.toUpperCase()).filter(Boolean));
  const rows: ExportRow[] = board.moulds.map((mould) => [
    mould.assetCode, mould.drawingNo, mould.model, mould.lifetimeShotCount, exportLocation(mould, copy),
  ]);
  // A confirmed SVC row with no MES record is still a physical mould.
  // Keep its drawing and Shot cells blank when the source cannot verify them.
  for (const entry of board.storageInventory?.entries ?? []) {
    if (entry.matchStatus !== "unmatched" || !entry.assetCode || knownAssets.has(entry.assetCode.toUpperCase())) continue;
    rows.push([entry.assetCode, "", entry.model, null, ["SVC", entry.rack, entry.position].filter(Boolean).join(" / ")]);
  }
  rows.sort(([left], [right]) => left.localeCompare(right, "en"));
  return [[copy.asset, copy.drawing, copy.model, copy.shots, copy.location], ...rows];
}

export async function downloadMouldWorkbook(board: MouldBoard, language: Language, date: string): Promise<void> {
  if (!board.moulds.length) throw new Error("Mould inventory is unavailable.");
  const XLSX = await import("xlsx");
  const rows = mouldExportRows(board, language);
  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  worksheet["!cols"] = [{ wch: 33 }, { wch: 34 }, { wch: 25 }, { wch: 23 }, { wch: 56 }];
  worksheet["!autofilter"] = { ref: `A1:E${rows.length}` };
  for (let index = 2; index <= rows.length; index++) {
    const cell = worksheet[`D${index}`];
    if (cell?.t === "n") cell.z = "#,##0";
  }
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, EXPORT_LABELS[language].sheet);
  XLSX.writeFile(workbook, `WJ-Mould-Inventory-${date}.xlsx`, { compression: true });
}
