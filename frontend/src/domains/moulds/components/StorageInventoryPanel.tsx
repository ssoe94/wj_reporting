import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowUpRight, Boxes, Search, X } from "lucide-react";
import type { MouldRecord } from "../api";
import {
  inventoryEntryMatches, inventoryMoulds, sourceReferencedMouldIds, storageInventoryCount, storageInventoryGroups, storageInventoryUnit,
  type InventorySite, type StorageInventory, type StorageInventoryEntry, type StorageInventoryGroup,
} from "../storage-inventory";
import styles from "./StorageInventoryPanel.module.css";

const COPY = {
  ko: {
    title: "별도 보관 인벤토리", close: "보관 인벤토리 닫기", other: "기타 위치", unknown: "미확인",
    search: "자산번호·모델·보관 위치 검색", rows: "행", moulds: "벌", assets: "자산번호", assetTypes: "종", source: "확인 목록",
    mes: "MES 연결", duplicate: "중복 자산", duplicateNote: "중복 자산의 원본 행은 모두 표시합니다.",
    locationConflict: "MES 위치 상이", unmatched: "MES 미연결", ambiguous: "MES 다중 일치", detail: "MES 상세",
    empty: "검색 결과가 없습니다.", unavailable: "보관 분류 자료를 아직 불러오지 못했습니다.",
    sourceRange: "원본 위치", rack: "랙 / 위치", part: "품번", mouldNo: "금형 번호", cavity: "Cavity",
    currentLocation: "MES 기록 위치", model: "모델", name: "금형명", confirmed: "확인", noLocation: "위치 미확인",
    classified: "MES 위치·이동 기록·금형팀 확인 기준", teamConfirmation: "금형팀 확인", unknownHint: "현재 기록으로 위치를 확인할 수 없는 금형",
    svcHint: "SVC 확인 목록 · 실제 위치와 MES 기록을 구분해 표시합니다.",
    lastMovement: "마지막 이동 기록", ambiguousMovement: "이동 기록 확인 필요", movementBasis: "현재 위치는 별도 확인 필요",
    additionalSvc: "추가 SVC 위치 기록",
    physical: "실물", sourceRows: "원본", displayedRows: "표시", individuallyLinked: "개별 MES 연결", identityPending: "MES 대응 미확정",
    sharedAsset: "공유 자산번호 · 서로 다른 실물", actualVariants: "확인된 실제 금형", actualMould: "실제 금형",
    rowMappingPending: "원본 행과 실제 금형의 대응 확인 중", sourceMouldNo: "원본 금형 번호",
    candidate: "MES 후보 · 개별 연결 미확정", sharedAssetReason: "자산번호 공유 사유 확인 중",
    physicalNote: "공유 자산번호의 금형도 실물을 각각 집계합니다.",
    repair: "수리중", externalCompanies: "외부 업체", chooseCompany: "업체·위치 선택",
  },
  zh: {
    title: "其他存放位置", close: "关闭存放清单", other: "其他位置", unknown: "未确认",
    search: "搜索资产号、机型、存放位置", rows: "行", moulds: "套", assets: "资产号", assetTypes: "种", source: "确认清单",
    mes: "MES 关联", duplicate: "重复资产", duplicateNote: "重复资产的原始行全部保留。",
    locationConflict: "MES 位置不一致", unmatched: "未关联 MES", ambiguous: "MES 多条匹配", detail: "MES 详情",
    empty: "没有匹配结果。", unavailable: "暂未取得存放分类数据。",
    sourceRange: "原表位置", rack: "货架 / 位置", part: "零件号", mouldNo: "模具号", cavity: "穴数",
    currentLocation: "MES 记录位置", model: "机型", name: "模具名称", confirmed: "确认", noLocation: "位置未确认",
    classified: "按 MES 位置、移动记录及模具组确认分类", teamConfirmation: "模具组确认", unknownHint: "当前记录无法确认位置的模具",
    svcHint: "SVC 已确认清单 · 实际位置与 MES 记录分别显示。",
    lastMovement: "最后移动记录", ambiguousMovement: "需确认移动记录", movementBasis: "当前位置需另行确认",
    additionalSvc: "其他 SVC 位置记录",
    physical: "实物", sourceRows: "原表", displayedRows: "显示", individuallyLinked: "逐套 MES 关联", identityPending: "MES 对应待确认",
    sharedAsset: "共用资产号 · 不同实物", actualVariants: "已确认实际模具", actualMould: "实际模具",
    rowMappingPending: "原表行与实际模具的对应关系待确认", sourceMouldNo: "原表模具号",
    candidate: "MES 候选 · 逐套关联未确认", sharedAssetReason: "共用资产号原因待确认",
    physicalNote: "共用资产号的模具按各套实物分别计数。",
    repair: "维修中", externalCompanies: "外部单位", chooseCompany: "选择单位及位置",
  },
};

type Props = {
  inventory: StorageInventory | null | undefined;
  moulds: MouldRecord[];
  language: "ko" | "zh";
  site: InventorySite;
  onSiteChange: (site: InventorySite) => void;
  onClose: () => void;
  onSelectMould: (instanceId: string) => void;
};

function SourceRow({ entry, copy, canOpen, onSelect }: {
  entry: StorageInventoryEntry;
  copy: typeof COPY.ko;
  canOpen: boolean;
  onSelect: (id: string) => void;
}) {
  const position = [entry.rack, entry.position].filter(Boolean).join(" / ") || "—";
  const identityPending = entry.matchStatus === "shared_asset_identity_pending";
  return (
    <details className={styles.sourceRow} data-testid="svc-source-row">
      <summary>
        <span className={styles.rowHeading}><strong>{entry.assetCode || "—"}</strong><span>{position}</span></span>
        <span className={styles.rowDescription}>{[entry.model, entry.name].filter(Boolean).join(" · ") || "—"}</span>
        <span className={styles.rowPart}>{entry.partNo || entry.mouldNo || "—"}</span>
        {identityPending ? <span className={styles.identityStatement}>
          <strong>{entry.confirmedMouldNo ? `${copy.actualMould} ${entry.confirmedMouldNo}` : `${copy.actualVariants} ${entry.confirmedMouldNos.join(" / ") || "—"}`}</strong>
          <span>{copy.sourceMouldNo}: {entry.mouldNo || "—"}</span>
          {!entry.confirmedMouldNo ? <span>{copy.rowMappingPending}</span> : null}
        </span> : null}
        {entry.locationConflict || ["duplicate_source_asset", "ambiguous", "shared_asset_identity_pending"].includes(entry.matchStatus) ? (
          <span className={styles.flags}>
            {entry.matchStatus === "duplicate_source_asset" ? <span>{copy.duplicate}</span> : null}
            {entry.matchStatus === "ambiguous" ? <span>{copy.ambiguous}</span> : null}
            {identityPending ? <span>{copy.sharedAsset}</span> : null}
            {entry.locationConflict ? <span><AlertTriangle size={13} aria-hidden="true" />{copy.locationConflict}</span> : null}
          </span>
        ) : null}
      </summary>
      <div className={styles.sourceDetail}>
        <dl>
          <div><dt>{copy.rack}</dt><dd>{position}</dd></div>
          <div><dt>{copy.part}</dt><dd>{entry.partNo || "—"}</dd></div>
          <div><dt>{identityPending ? copy.sourceMouldNo : copy.mouldNo}</dt><dd>{entry.mouldNo || "—"}</dd></div>
          {identityPending ? <>
            <div><dt>{copy.actualVariants}</dt><dd>{entry.confirmedMouldNos.join(" / ") || "—"}</dd></div>
            <div><dt>{copy.actualMould}</dt><dd>{entry.confirmedMouldNo || copy.rowMappingPending}</dd></div>
            <div><dt>{copy.candidate}</dt><dd>{entry.candidateMouldCodes.join(" / ") || "—"}</dd></div>
          </> : null}
          <div><dt>{copy.cavity}</dt><dd>{entry.cavityCount || "—"}</dd></div>
          <div><dt>{copy.sourceRange}</dt><dd>{entry.sourceRange || entry.sourceRow || "—"}</dd></div>
          {entry.instanceId || entry.recordLocation ? <div><dt>{copy.currentLocation}</dt><dd>{entry.recordLocation || copy.noLocation}</dd></div> : null}
        </dl>
        {identityPending ? <p className={styles.identityNote}>{copy.sharedAssetReason}</p> : null}
        {!identityPending && canOpen && entry.instanceId ? <button onClick={() => onSelect(entry.instanceId!)} type="button">{copy.detail}<ArrowUpRight size={15} aria-hidden="true" /></button> : null}
      </div>
    </details>
  );
}

export function StorageInventoryPanel({ inventory, moulds, language, site, onSiteChange, onClose, onSelectMould }: Props) {
  const copy = COPY[language];
  const [searchState, setSearchState] = useState({ site, value: "" });
  const search = searchState.site === site ? searchState.value : "";
  const setSearch = (value: string) => setSearchState({ site, value });
  const panelRef = useRef<HTMLElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    panelRef.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  const records = useMemo(() => inventoryMoulds(inventory, site, moulds), [inventory, site, moulds]);
  const groups = useMemo(() => storageInventoryGroups(inventory), [inventory]);
  const availableIds = useMemo(() => new Set(moulds.map((mould) => mould.instanceId)), [moulds]);
  const entries = (inventory?.entries ?? []).filter((entry) => inventoryEntryMatches(entry, search));
  const term = search.normalize("NFKC").trim().toLocaleLowerCase();
  const visibleRecords = records.filter((mould) => !term || [
    mould.assetCode, mould.mouldCode, mould.model, mould.name, mould.drawingNo,
    mould.location.code, mould.location.label, mould.location.parentLabel, mould.location.zoneLabel,
    ...(mould.inventory?.sourceLocations ?? []), mould.inventory?.lastMovement?.toLocation ?? "", mould.inventory?.vendor?.name ?? "", site,
  ].join(" ").normalize("NFKC").toLocaleLowerCase().includes(term));
  const sourceReferencedIds = useMemo(() => sourceReferencedMouldIds(inventory), [inventory]);
  const additionalSvcRecords = visibleRecords.filter((mould) => !sourceReferencedIds.has(mould.instanceId));
  const reconciliation = inventory?.reconciliation;
  const groupLabel = (group: StorageInventoryGroup) => group.site === "OTHER" ? copy.other : group.site === "UNCONFIRMED" ? copy.unknown : group.name;
  const selectedGroup = groups.find((group) => group.site === site);
  const selectedLabel = selectedGroup ? groupLabel(selectedGroup) : site.replace(/^VENDOR:/, "");
  const generalGroups = groups.filter((group) => ["svc", "other", "unconfirmed"].includes(group.category));
  const repairGroups = groups.filter((group) => group.category === "repair");
  const externalGroups = groups.filter((group) => group.category === "external");
  const selectSite = (nextSite: InventorySite) => {
    setSearch("");
    onSiteChange(nextSite);
    if (resultsRef.current) resultsRef.current.scrollTop = 0;
  };
  const renderGroupButton = (group: StorageInventoryGroup) => <button
    aria-pressed={site === group.site}
    aria-controls="mould-inventory-results"
    className={site === group.site ? styles.activeSite : ""}
    key={group.site}
    onClick={() => selectSite(group.site)}
    title={groupLabel(group)}
    type="button"
  ><span>{groupLabel(group)}</span><strong>{storageInventoryCount(inventory, group.site) ?? "—"}</strong></button>;
  const movementTime = (value: string) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value || "—" : new Intl.DateTimeFormat(language === "ko" ? "ko-KR" : "zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  };
  const renderMouldRow = (mould: MouldRecord) => (
    <button className={styles.mouldRow} key={mould.instanceId} onClick={() => onSelectMould(mould.instanceId)} type="button">
      <span className={styles.rowHeading}><strong>{mould.assetCode || mould.mouldCode}</strong><span>{mould.location.label || mould.location.code || copy.noLocation}</span></span>
      <span className={styles.rowDescription}>{[mould.model, mould.name].filter(Boolean).join(" · ") || "—"}</span>
      <span className={styles.rowPart}>{mould.drawingNo || mould.mouldCode}</span>
      {mould.inventory?.basis === "team_confirmation" ? <span className={styles.movement}>{copy.teamConfirmation} · {mould.inventory.confirmedOn}</span> : null}
      {mould.inventory?.lastMovement ? <span className={styles.movement}>
        {copy.lastMovement} → <strong>{mould.inventory.lastMovement.toLocation || copy.noLocation}</strong>
        <span>{movementTime(mould.inventory.lastMovement.occurredAt)}{mould.inventory.lastMovement.ambiguous ? ` · ${copy.ambiguousMovement}` : ""}</span>
      </span> : null}
    </button>
  );
  return (
    <aside aria-labelledby="mould-storage-inventory-title" className={styles.panel} id="mould-storage-inventory" ref={panelRef} tabIndex={-1}>
      <header className={styles.header}>
        <h3 id="mould-storage-inventory-title"><Boxes size={19} aria-hidden="true" />{copy.title}</h3>
        <button aria-label={copy.close} onClick={onClose} type="button"><X size={21} aria-hidden="true" /></button>
      </header>
      <div aria-label={copy.chooseCompany} className={styles.companyPicker} id="mould-inventory-company-picker">
        {generalGroups.length ? <div className={styles.sites}>{generalGroups.map(renderGroupButton)}</div> : null}
        {repairGroups.length ? <section className={styles.repairSection} aria-labelledby="mould-repair-companies-title">
          <h4 id="mould-repair-companies-title">{copy.repair}</h4>
          <div className={styles.sites}>{repairGroups.map(renderGroupButton)}</div>
        </section> : null}
        {externalGroups.length ? <section className={styles.externalSection} aria-labelledby="mould-external-companies-title">
          <h4 id="mould-external-companies-title">{copy.externalCompanies}</h4>
          <div className={styles.sites}>{externalGroups.map(renderGroupButton)}</div>
        </section> : null}
      </div>
      <div className={styles.basis}>
        <strong aria-live="polite">{selectedLabel} <span>{storageInventoryCount(inventory, site) ?? "—"}{copy[storageInventoryUnit(inventory, site)]}</span></strong>
        {site === "SVC" && inventory ? <>
          <p title={`${inventory.source.filename} · ${inventory.source.sheet}`}>{copy.source} <strong>{storageInventoryCount(inventory, "SVC") ?? "—"}{copy[storageInventoryUnit(inventory, "SVC")]}</strong> · {inventory.source.confirmedOn || "—"}</p>
        </> : <p>{site === "UNCONFIRMED" ? copy.unknownHint : copy.classified}</p>}
      </div>
      <label className={styles.search}><Search size={16} aria-hidden="true" /><span className={styles.srOnly}>{copy.search}</span><input type="search" placeholder={copy.search} value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      <div className={styles.results} id="mould-inventory-results" ref={resultsRef}>
        {!inventory ? <p className={styles.empty} role="status">{copy.unavailable}</p> : site === "SVC" ? (
          <>
            {entries.map((entry) => <SourceRow key={entry.entryId} entry={entry} copy={copy} canOpen={Boolean(entry.instanceId && availableIds.has(entry.instanceId))} onSelect={onSelectMould} />)}
            {additionalSvcRecords.length ? <section aria-label={copy.additionalSvc}>
              <h4 className={styles.additionalHeading}>{copy.additionalSvc}<span>{additionalSvcRecords.length}{copy.moulds}</span></h4>
              {additionalSvcRecords.map(renderMouldRow)}
            </section> : null}
            {!entries.length && !additionalSvcRecords.length ? <p className={styles.empty} role="status">{copy.empty}</p> : null}
          </>
        ) : visibleRecords.length ? visibleRecords.map(renderMouldRow) : <p className={styles.empty} role="status">{copy.empty}</p>}
      </div>
      {inventory ? <footer className={styles.footer}>{selectedLabel} · {site === "SVC" ? `${reconciliation?.physicalMouldCount != null ? `${reconciliation.physicalMouldCount}${copy.moulds} · ${search.trim() ? copy.displayedRows : copy.sourceRows} ` : ""}${entries.length}${copy.rows}${additionalSvcRecords.length ? ` + ${additionalSvcRecords.length}${copy.moulds}` : ""}` : `${visibleRecords.length}${copy.moulds}`}{site === "SVC" && inventory.source.sheet ? <span>{inventory.source.sheet}</span> : null}</footer> : null}
    </aside>
  );
}
