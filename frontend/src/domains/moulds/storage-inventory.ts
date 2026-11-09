export const INVENTORY_SITES = ["SVC", "TIANLU", "OTHER", "UNCONFIRMED"] as const;
export type InventorySite = typeof INVENTORY_SITES[number];

export type MouldInventory = {
  site: InventorySite;
  basis: "confirmed_list" | "mes_location" | "last_movement" | "unconfirmed";
  sourceRanges: string[];
  sourceLocations: string[];
  confirmedOn: string | null;
  locationConflict: boolean;
  identityPending: boolean;
  confirmedMouldNos: string[];
  lastMovement: {
    occurredAt: string;
    toLocation: string;
    fromLocation: string;
    reason: string;
    timeQuality: string;
    ambiguous: boolean;
  } | null;
};

export type StorageInventoryEntry = {
  entryId: string;
  site: "SVC";
  sourceRow: number | null;
  sourceRange: string;
  rack: string;
  position: string;
  assetCode: string;
  model: string;
  name: string;
  partNo: string;
  mouldNo: string;
  cavityCount: string;
  instanceId: string | null;
  matchStatus: "matched" | "duplicate_source_asset" | "unmatched" | "ambiguous" | "shared_asset_identity_pending";
  candidateInstanceIds: string[];
  candidateMouldCodes: string[];
  confirmedMouldNos: string[];
  confirmedMouldNo: string | null;
  recordLocation: string;
  locationConflict: boolean;
};

export type StorageInventory = {
  source: {
    filename: string;
    sheet: string;
    confirmedOn: string;
    mouldRows: number | null;
    uniqueAssets: number | null;
    duplicateAssets: string[];
  };
  entries: StorageInventoryEntry[];
  identityConfirmations: Array<{
    assetCode: string;
    physicalMouldCount: number | null;
    mouldNos: string[];
    sourceEntryIds: string[];
    confirmedOn: string;
    rowMouldNos: Record<string, string>;
  }>;
  reconciliation: {
    physicalMouldCount: number | null;
    individuallyLinkedMouldCount: number | null;
    identityPendingMouldCount: number | null;
  } | null;
  groups: Array<{ site: InventorySite; mouldCount: number | null; entryCount: number | null; instanceIds: string[] }>;
};

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const field = (value: RecordValue, snake: string, camel: string) => value[snake] ?? value[camel];
const string = (value: unknown) => typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
const strings = (value: unknown) => Array.isArray(value) ? value.map(string).filter(Boolean) : [];
const count = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
};
const boolean = (value: unknown) => value === true || value === 1 || value === "true";
const site = (value: unknown): InventorySite | null => INVENTORY_SITES.includes(value as InventorySite) ? value as InventorySite : null;

export function normalizeMouldInventory(value: unknown): MouldInventory | null {
  const raw = record(value);
  const location = site(raw.site);
  if (!location) return null;
  const movementValue = field(raw, "last_movement", "lastMovement");
  const movement = record(movementValue);
  return {
    site: location,
    basis: raw.basis === "confirmed_list" || raw.basis === "mes_location" || raw.basis === "last_movement" ? raw.basis : "unconfirmed",
    sourceRanges: strings(field(raw, "source_ranges", "sourceRanges")),
    sourceLocations: strings(field(raw, "source_locations", "sourceLocations")),
    confirmedOn: string(field(raw, "confirmed_on", "confirmedOn")) || null,
    locationConflict: boolean(field(raw, "location_conflict", "locationConflict")),
    identityPending: boolean(field(raw, "identity_pending", "identityPending")),
    confirmedMouldNos: strings(field(raw, "confirmed_mould_nos", "confirmedMouldNos")),
    lastMovement: movementValue && Object.keys(movement).length ? {
      occurredAt: string(field(movement, "occurred_at", "occurredAt")),
      toLocation: string(field(movement, "to_location", "toLocation")),
      fromLocation: string(field(movement, "from_location", "fromLocation")),
      reason: string(movement.reason),
      timeQuality: string(field(movement, "time_quality", "timeQuality")),
      ambiguous: boolean(movement.ambiguous),
    } : null,
  };
}

export function normalizeStorageInventory(value: unknown): StorageInventory | null {
  const raw = record(value);
  if (!Array.isArray(raw.entries) || !Array.isArray(raw.groups)) return null;
  const source = record(raw.source);
  const reconciliationValue = field(raw, "reconciliation", "reconciliation");
  const reconciliation = record(reconciliationValue);
  const confirmations = field(raw, "identity_confirmations", "identityConfirmations");
  return {
    source: {
      filename: string(source.filename),
      sheet: string(source.sheet),
      confirmedOn: string(field(source, "confirmed_on", "confirmedOn")),
      mouldRows: count(field(source, "mould_rows", "mouldRows")),
      uniqueAssets: count(field(source, "unique_assets", "uniqueAssets")),
      duplicateAssets: strings(field(source, "duplicate_assets", "duplicateAssets")),
    },
    entries: raw.entries.map((value, index) => {
      const row = record(value);
      const status = field(row, "match_status", "matchStatus");
      return {
        entryId: string(field(row, "entry_id", "entryId")) || `source-row-${index}`,
        site: "SVC",
        sourceRow: count(field(row, "source_row", "sourceRow")),
        sourceRange: string(field(row, "source_range", "sourceRange")),
        rack: string(row.rack),
        position: string(row.position),
        assetCode: string(field(row, "asset_code", "assetCode")),
        model: string(row.model),
        name: string(row.name),
        partNo: string(field(row, "part_no", "partNo")),
        mouldNo: string(field(row, "mould_no", "mouldNo")),
        cavityCount: string(field(row, "cavity_count", "cavityCount")),
        instanceId: string(field(row, "instance_id", "instanceId")) || null,
        matchStatus: status === "matched" || status === "duplicate_source_asset" || status === "ambiguous" || status === "shared_asset_identity_pending" ? status : "unmatched",
        candidateInstanceIds: strings(field(row, "candidate_instance_ids", "candidateInstanceIds")),
        candidateMouldCodes: strings(field(row, "candidate_mould_codes", "candidateMouldCodes")),
        confirmedMouldNos: strings(field(row, "confirmed_mould_nos", "confirmedMouldNos")),
        confirmedMouldNo: string(field(row, "confirmed_mould_no", "confirmedMouldNo")) || null,
        recordLocation: string(field(row, "record_location", "recordLocation")),
        locationConflict: boolean(field(row, "location_conflict", "locationConflict")),
      };
    }),
    identityConfirmations: Array.isArray(confirmations) ? confirmations.map((value) => {
      const confirmation = record(value);
      const mapping = record(field(confirmation, "row_mould_nos", "rowMouldNos"));
      return {
        assetCode: string(field(confirmation, "asset_code", "assetCode")),
        physicalMouldCount: count(field(confirmation, "physical_mould_count", "physicalMouldCount")),
        mouldNos: strings(field(confirmation, "mould_nos", "mouldNos")),
        sourceEntryIds: strings(field(confirmation, "source_entry_ids", "sourceEntryIds")),
        confirmedOn: string(field(confirmation, "confirmed_on", "confirmedOn")),
        rowMouldNos: Object.fromEntries(Object.entries(mapping).flatMap(([key, value]) => string(value) ? [[key, string(value)]] : [])),
      };
    }) : [],
    reconciliation: reconciliationValue && Object.keys(reconciliation).length ? {
      physicalMouldCount: count(field(reconciliation, "physical_mould_count", "physicalMouldCount")),
      individuallyLinkedMouldCount: count(field(reconciliation, "individually_linked_mould_count", "individuallyLinkedMouldCount")),
      identityPendingMouldCount: count(field(reconciliation, "identity_pending_mould_count", "identityPendingMouldCount")),
    } : null,
    groups: raw.groups.flatMap((value) => {
      const group = record(value);
      const location = site(group.site);
      return location ? [{
        site: location,
        mouldCount: count(field(group, "mould_count", "mouldCount")),
        entryCount: count(field(group, "entry_count", "entryCount")),
        instanceIds: [...new Set(strings(field(group, "instance_ids", "instanceIds")))],
      }] : [];
    }),
  };
}

export function storageInventoryCount(inventory: StorageInventory | null | undefined, location: InventorySite): number | null {
  if (!inventory) return null;
  const group = inventory.groups.find((item) => item.site === location);
  return location === "SVC" ? inventory.reconciliation?.physicalMouldCount ?? inventory.source.mouldRows ?? group?.entryCount ?? null : group?.mouldCount ?? null;
}

export function storageInventoryUnit(inventory: StorageInventory | null | undefined, location: InventorySite): "moulds" | "rows" {
  return location === "SVC" && inventory?.reconciliation?.physicalMouldCount == null ? "rows" : "moulds";
}

export function inventoryEntryMatches(entry: StorageInventoryEntry, search: string): boolean {
  const term = search.normalize("NFKC").trim().toLocaleLowerCase();
  return !term || [entry.site, entry.assetCode, entry.model, entry.name, entry.partNo, entry.mouldNo,
    entry.rack, entry.position, entry.sourceRange, entry.recordLocation, ...entry.confirmedMouldNos,
    entry.confirmedMouldNo, ...entry.candidateMouldCodes].join(" ").normalize("NFKC").toLocaleLowerCase().includes(term);
}

export function sourceLinkedMouldIds(inventory: StorageInventory | null | undefined): Set<string> {
  return new Set((inventory?.entries ?? []).flatMap((entry) => entry.instanceId && entry.matchStatus !== "shared_asset_identity_pending" ? [entry.instanceId] : []));
}

export function sourceReferencedMouldIds(inventory: StorageInventory | null | undefined): Set<string> {
  return new Set((inventory?.entries ?? []).flatMap((entry) => [
    ...(entry.instanceId ? [entry.instanceId] : []), ...entry.candidateInstanceIds,
  ]));
}

export function inventoryMoulds<T extends { instanceId: string }>(inventory: StorageInventory | null | undefined, location: InventorySite, moulds: T[]): T[] {
  const ids = new Set(inventory?.groups.find((group) => group.site === location)?.instanceIds ?? []);
  const found = new Set<string>();
  return moulds.filter((mould) => {
    if (!ids.has(mould.instanceId) || found.has(mould.instanceId)) return false;
    found.add(mould.instanceId);
    return true;
  });
}
