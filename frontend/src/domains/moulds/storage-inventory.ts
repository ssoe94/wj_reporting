export const INVENTORY_SITES = ["SVC", "TIANLU", "OTHER", "UNCONFIRMED"] as const;
export type InventorySite = typeof INVENTORY_SITES[number];

export type MouldInventory = {
  site: InventorySite;
  basis: "confirmed_list" | "mes_location" | "last_movement" | "unconfirmed";
  sourceRanges: string[];
  sourceLocations: string[];
  confirmedOn: string | null;
  locationConflict: boolean;
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
  matchStatus: "matched" | "duplicate_source_asset" | "unmatched" | "ambiguous";
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
        matchStatus: status === "matched" || status === "duplicate_source_asset" || status === "ambiguous" ? status : "unmatched",
        recordLocation: string(field(row, "record_location", "recordLocation")),
        locationConflict: boolean(field(row, "location_conflict", "locationConflict")),
      };
    }),
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
  return location === "SVC" ? inventory.source.mouldRows ?? group?.entryCount ?? null : group?.mouldCount ?? null;
}

export function inventoryEntryMatches(entry: StorageInventoryEntry, search: string): boolean {
  const term = search.normalize("NFKC").trim().toLocaleLowerCase();
  return !term || [entry.site, entry.assetCode, entry.model, entry.name, entry.partNo, entry.mouldNo,
    entry.rack, entry.position, entry.sourceRange, entry.recordLocation].join(" ").normalize("NFKC").toLocaleLowerCase().includes(term);
}

export function sourceLinkedMouldIds(inventory: StorageInventory | null | undefined): Set<string> {
  return new Set((inventory?.entries ?? []).flatMap((entry) => entry.instanceId ? [entry.instanceId] : []));
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
