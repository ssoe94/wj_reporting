import type {
  MouldBoard,
  MouldDetail,
  MouldLocation,
  MouldLocationKind,
  MouldMachineSlot,
  MouldRecord,
} from "@/domains/moulds/api";

const FALLBACK_AS_OF = "2026-08-05T13:37:00+08:00";

const MACHINE_TONNAGE: Record<number, string> = {
  1: "850T",
  2: "850T",
  3: "1300T",
  4: "1400T",
  5: "1400T",
  6: "2500T",
  7: "1300T",
  8: "850T",
  9: "850T",
  10: "650T",
  11: "550T",
  12: "550T",
  13: "450T",
  14: "850T",
  15: "650T",
  16: "1050T",
  17: "1200T",
};

const MODELS = ["HU715", "NDIF", "COVER", "BASE", "HOUSING", "PANEL", "FRAME", "TRAY"];

function makeLocation(
  code: string,
  kind: MouldLocationKind,
  options: { label?: string; machineNumber?: number | null; mouldCount?: number; zoneCode?: string } = {},
): MouldLocation {
  const zoneCode = options.zoneCode ?? code.match(/^([ABC])/)?.[1] ?? "";
  return {
    id: `fallback-location-${code}`,
    code,
    label: options.label ?? code,
    kind,
    machineNumber: options.machineNumber ?? null,
    parentCode: zoneCode,
    parentLabel: zoneCode ? `${zoneCode}존` : "",
    zoneCode,
    zoneLabel: zoneCode ? `${zoneCode}존` : "",
    level: zoneCode ? 2 : 1,
    mouldCount: options.mouldCount ?? 0,
    conflict: false,
  };
}

function storageCodes(zone: "A" | "B" | "C", rows: number, columns: number): string[] {
  const codes: string[] = [];
  for (let row = 1; row <= rows; row += 1) {
    for (let column = 1; column <= columns; column += 1) {
      codes.push(`${zone}${row}-${column}`);
    }
  }
  return codes;
}

const A_CODES = storageCodes("A", 6, 6);
const B_CODES = storageCodes("B", 4, 6);
const C_CODES = storageCodes("C", 9, 18);

const A_OCCUPIED = new Set([
  "A1-1", "A1-3", "A1-5", "A2-2", "A2-4", "A2-6", "A3-1", "A3-3", "A3-6", "A4-2", "A4-4",
  "A4-5", "A5-1", "A5-2", "A5-4", "A5-6", "A6-1", "A6-2", "A6-3", "A6-4", "A6-5", "A6-6",
]);
const B_OCCUPIED = new Set([
  "B1-2", "B1-4", "B2-1", "B2-3", "B2-5", "B3-1", "B3-3", "B3-4", "B3-6", "B4-1", "B4-2", "B4-4",
  "B4-5", "B4-6", "B2-6",
]);
const C_OCCUPIED = new Set([
  "C1-2", "C2-2", "C3-4", "C3-8", "C4-4", "C5-2", "C6-6", "C7-3", "C8-9", "C9-18",
]);

const STORAGE_LOCATIONS = [...A_CODES, ...B_CODES, ...C_CODES].map((code) => makeLocation(code, "storage"));
const OCCUPIED_STORAGE_CODES = [...A_OCCUPIED, ...B_OCCUPIED, ...C_OCCUPIED];

const FALLBACK_MACHINES: MouldMachineSlot[] = Array.from({ length: 17 }, (_, index) => {
  const number = index + 1;
  const tonnage = MACHINE_TONNAGE[number] ?? "";
  return {
    number,
    deviceCode: `${tonnage}-${number}`,
    locationCode: `#${number}-${tonnage}`,
    label: `${number}호기`,
    tonnage,
  };
});

function changedAt(index: number): string {
  const hours = (index * 7) % 96;
  return new Date(Date.parse(FALLBACK_AS_OF) - hours * 60 * 60 * 1_000).toISOString();
}

function statusFor(kind: MouldLocationKind): { code: string; label: string } {
  if (kind === "machine") return { code: "mounted", label: "장착" };
  if (kind === "storage") return { code: "stored", label: "보관 중" };
  if (kind === "repair") return { code: "repair", label: "수리 중" };
  if (kind === "offsite") return { code: "offsite", label: "외부" };
  return { code: "unknown", label: "미확인" };
}

function makeMould(index: number, location: MouldLocation, code?: string): MouldRecord {
  const mouldCode = code ?? `MOLD-${String(600 + index).padStart(4, "0")}`;
  const status = statusFor(location.kind);
  const output = 8_600 + index * 137;
  return {
    instanceId: `fallback-${mouldCode.toLowerCase()}`,
    mouldCode,
    assetCode: `NDIF${String(3_520_000 + index * 31)}`,
    name: `${MODELS[index % MODELS.length]} ${index % 2 ? "하우징" : "커버"} 금형`,
    drawingNo: index % 3 === 0 ? `MBN${665_000 + index}` : "",
    model: MODELS[index % MODELS.length] ?? "",
    statusCode: status.code,
    statusLabel: status.label,
    classification: "금형",
    cavityCount: (index % 4) + 1,
    serialNo: `WJ-M-${String(index + 1).padStart(4, "0")}`,
    supplier: index % 2 ? "WJ Tooling" : "협력 금형사",
    currentOutputAmount: output,
    currentOutputBatchAmount: Math.round(output / 12),
    lifespanStatus: index % 9 === 0 ? "점검 필요" : "정상",
    maintenanceStatus: "대기 없음",
    repairStatus: location.kind === "repair" ? "진행 중" : "정상",
    summaryCategory: location.kind,
    location: { ...location, mouldCount: 1 },
    finalChangedAt: changedAt(index),
    recordUpdatedAt: changedAt(index),
    positionChangedAt: "",
    timeQuality: "record_update",
    warnings: [],
  };
}

const mountedMoulds = FALLBACK_MACHINES.map((machine, index) => makeMould(
  index,
  makeLocation(machine.locationCode, "machine", {
    label: machine.label,
    machineNumber: machine.number,
    mouldCount: 1,
  }),
));

const storedMoulds = OCCUPIED_STORAGE_CODES.map((code, index) => {
  const mould = makeMould(20 + index, makeLocation(code, "storage", { mouldCount: 1 }));
  if (code !== "C9-18") return mould;
  return {
    ...mould,
    instanceId: "fallback-mold-0674",
    mouldCode: "MOLD-0674",
    assetCode: "NDIF03534242",
    name: "NDIF 하우징 금형",
    drawingNo: "MBN66503201",
    model: "HU715",
    cavityCount: 1,
    currentOutputAmount: 1_523,
    currentOutputBatchAmount: null,
    finalChangedAt: "2026-08-04T05:26:00+08:00",
    recordUpdatedAt: "2026-08-04T05:26:00+08:00",
  };
});

const repairMoulds = Array.from({ length: 2 }, (_, index) => makeMould(
  70 + index,
  makeLocation(`REPAIR-${String(index + 1).padStart(2, "0")}`, "repair", { label: `수리존 R-${String(index + 1).padStart(2, "0")}` }),
  `MOLD-R${String(index + 1).padStart(3, "0")}`,
));
const offsiteMoulds = Array.from({ length: 3 }, (_, index) => makeMould(
  74 + index,
  makeLocation(`OFFSITE-${String(index + 1).padStart(2, "0")}`, "offsite", { label: `외부 보관 ${index + 1}` }),
  `MOLD-O${String(index + 1).padStart(3, "0")}`,
));
const unknownMoulds = Array.from({ length: 12 }, (_, index) => makeMould(
  80 + index,
  makeLocation(`UNKNOWN-${String(index + 1).padStart(2, "0")}`, "unknown", { label: "위치 미확인" }),
  `MOLD-U${String(index + 1).padStart(3, "0")}`,
));

const FALLBACK_MOULDS = [
  ...mountedMoulds,
  ...storedMoulds,
  ...repairMoulds,
  ...offsiteMoulds,
  ...unknownMoulds,
];

const occupiedCounts = new Map<string, number>();
FALLBACK_MOULDS.forEach((mould) => {
  const code = mould.location.code;
  occupiedCounts.set(code, (occupiedCounts.get(code) ?? 0) + 1);
});

export const FALLBACK_MOULD_BOARD: MouldBoard = {
  summary: {
    total: FALLBACK_MOULDS.length,
    mounted: mountedMoulds.length,
    stored: storedMoulds.length,
    maintenance: 0,
    repair: repairMoulds.length,
    offsite: offsiteMoulds.length,
    unknown: unknownMoulds.length,
    conflicts: 0,
  },
  locations: STORAGE_LOCATIONS.map((location) => ({
    ...location,
    mouldCount: occupiedCounts.get(location.code) ?? 0,
  })),
  machines: FALLBACK_MACHINES,
  moulds: FALLBACK_MOULDS,
  finalChangedAt: "2026-08-04T05:26:00+08:00",
  dataFreshness: {
    fetchedAt: FALLBACK_AS_OF,
    sourceLatestAt: "2026-08-04T05:26:00+08:00",
    status: "fallback",
  },
  capabilities: {
    movement_history: true,
    production_history: true,
    repair_history: true,
    attachments: false,
    position_event_time: false,
  },
  warnings: [
    {
      code: "fallback_dataset",
      message: "MES API 연결 전 화면 검증을 위한 결정적 예시 데이터입니다. 실제 운영 수치가 아닙니다.",
      params: {},
    },
    {
      code: "position_event_unavailable",
      message: "예시 데이터의 최종 변경 시각은 레코드 수정 시각이며 장착·해제 시각으로 사용할 수 없습니다.",
      params: {},
    },
  ],
  calculationBasis: [
    "금형 현재 위치가 사출기 위치이면 장착, A/B/C 좌표이면 보관으로 분류합니다.",
    "위치 변경 로그가 없는 경우 최종 변경 시각은 금형 레코드 수정 시각을 사용합니다.",
  ],
};

function detailFor(mould: MouldRecord): MouldDetail {
  const isSelectedExample = mould.mouldCode === "MOLD-0674";
  const fallbackLifetimeProduction = isSelectedExample
    ? 17_294
    : 7_000 + (mould.currentOutputAmount ?? 0) * 6;
  return {
    ...mould,
    acquiredAt: isSelectedExample ? "2021-06-17T00:00:00+08:00" : "2022-03-01T00:00:00+08:00",
    enabledAt: isSelectedExample ? "2021-07-01T00:00:00+08:00" : "2022-03-15T00:00:00+08:00",
    coverFileId: "",
    attachments: [],
    movements: isSelectedExample ? [
      {
        id: "movement-0674-1",
        occurredAt: "2026-08-04T05:26:00+08:00",
        fromLocation: "7호기",
        toLocation: "C9-18",
        reason: "언로드 후 보관 완료",
        operatorName: "김현수",
        timeQuality: "event_time",
      },
      {
        id: "movement-0674-2",
        occurredAt: "2026-08-03T16:18:00+08:00",
        fromLocation: "C9-18",
        toLocation: "7호기",
        reason: "생산 장착",
        operatorName: "이준호",
        timeQuality: "event_time",
      },
      {
        id: "movement-0674-3",
        occurredAt: "2026-07-31T09:42:00+08:00",
        fromLocation: "7호기",
        toLocation: "C9-18",
        reason: "생산 완료 언로드",
        operatorName: "이준호",
        timeQuality: "event_time",
      },
    ] : [
      {
        id: `${mould.instanceId}-movement-1`,
        occurredAt: mould.finalChangedAt,
        fromLocation: "이전 위치 미확인",
        toLocation: mould.location.label || mould.location.code,
        reason: "현재 위치 등록",
        operatorName: "",
        timeQuality: mould.timeQuality,
      },
    ],
    productionHistory: [
      {
        id: `${mould.instanceId}-production-2026-08`,
        period: "2026-08",
        year: 2026,
        month: 8,
        quantity: isSelectedExample ? 417 : 280 + (mould.currentOutputBatchAmount ?? 0) % 120,
        cumulativeQuantity: fallbackLifetimeProduction,
        unit: "Shot",
        recordedAt: FALLBACK_AS_OF,
      },
      {
        id: `${mould.instanceId}-production-2026-07`,
        period: "2026-07",
        year: 2026,
        month: 7,
        quantity: isSelectedExample ? 1_866 : 1_120,
        cumulativeQuantity: Math.max(0, fallbackLifetimeProduction - (isSelectedExample ? 417 : 280)),
        unit: "Shot",
        recordedAt: "2026-07-31T23:59:00+08:00",
      },
    ],
    repairHistory: isSelectedExample ? [
      {
        id: "repair-0674-1",
        recordCode: "REPAIR-20260728-0674",
        requestedAt: "2026-07-28T13:47:00+08:00",
        startedAt: "2026-07-28T14:20:00+08:00",
        finishedAt: "2026-07-28T17:35:00+08:00",
        type: "수리",
        content: "이젝터 핀 교체 (16EA)",
        vendor: "금형보전팀",
        creatorName: "박성민",
        cumulativeOutputAmount: 16_877,
        attachmentIds: [],
      },
    ] : [],
    capabilities: FALLBACK_MOULD_BOARD.capabilities,
    dataFreshness: FALLBACK_MOULD_BOARD.dataFreshness,
    calculationBasis: FALLBACK_MOULD_BOARD.calculationBasis,
  };
}

const FALLBACK_DETAILS = new Map(
  FALLBACK_MOULDS.map((mould) => [mould.instanceId, detailFor(mould)]),
);

export function getFallbackMouldDetail(instanceId: string): MouldDetail | undefined {
  return FALLBACK_DETAILS.get(instanceId);
}
