import assert from "node:assert/strict";
import test from "node:test";
import {
  inventoryEntryMatches, inventoryMoulds, normalizeMouldInventory, normalizeStorageInventory, sourceLinkedMouldIds, storageInventoryCount,
} from "../src/domains/moulds/storage-inventory.ts";

const payload = {
  source: { filename: "SVC模具仓库清单.xlsx", sheet: "存放模具2026.11.9", confirmed_on: "2026-11-09", mould_rows: 3, unique_assets: 2, duplicate_assets: ["NDIF001"] },
  entries: [
    { entry_id: "svc-9", source_row: 9, source_range: "A9:J9", rack: "A", position: "1-1", asset_code: "NDIF001", model: "TEST", name: "后盖", part_no: "P1", cavity_count: 1, instance_id: "mes-1", match_status: "duplicate_source_asset", record_location: "待确认", location_conflict: true },
    { entry_id: "svc-12", source_row: 12, source_range: "A12:J12", rack: "B", position: "2-1", asset_code: "NDIF001", instance_id: "mes-1", match_status: "duplicate_source_asset" },
    { entry_id: "svc-15", source_row: 15, asset_code: "NDIF002", instance_id: null, match_status: "unmatched" },
  ],
  groups: [
    { site: "SVC", mould_count: 1, entry_count: 3, instance_ids: ["mes-1", "mes-1"] },
    { site: "TIANLU", mould_count: 2, entry_count: 2, instance_ids: ["mes-2", "mes-3"] },
    { site: "OTHER", mould_count: 0, entry_count: 0, instance_ids: [] },
  ],
};

test("SVC source rows stay distinct while MES identities are deduplicated", () => {
  const inventory = normalizeStorageInventory(payload)!;
  assert.equal(inventory.entries.length, 3);
  assert.deepEqual(inventory.entries.map((row) => row.entryId), ["svc-9", "svc-12", "svc-15"]);
  assert.deepEqual(inventory.groups[0]?.instanceIds, ["mes-1"]);
  assert.equal(inventory.entries[0]?.locationConflict, true);
  assert.equal(inventory.entries[0]?.sourceRange, "A9:J9");
  assert.equal(inventory.entries[0]?.cavityCount, "1");
  assert.equal(inventory.entries[2]?.instanceId, null);
  assert.equal(inventory.entries[2]?.matchStatus, "unmatched");
  assert.equal(storageInventoryCount(inventory, "SVC"), 3);
  assert.equal(storageInventoryCount(inventory, "TIANLU"), 2);
  assert.equal(storageInventoryCount(inventory, "OTHER"), 0);
});

test("missing backend inventory or category does not manufacture zero counts", () => {
  for (const value of [undefined, null, {}, { entries: [] }]) {
    const inventory = normalizeStorageInventory(value);
    assert.equal(inventory, null);
    assert.equal(storageInventoryCount(inventory, "SVC"), null);
  }
  assert.equal(storageInventoryCount(normalizeStorageInventory(payload), "UNCONFIRMED"), null);
  assert.equal(storageInventoryCount(normalizeStorageInventory({ entries: [], groups: [{ site: "SVC" }] }), "SVC"), null);
});

test("SVC source connections exclude additional location records and count duplicate source links once", () => {
  const inventory = normalizeStorageInventory(payload)!;
  inventory.groups[0]!.instanceIds.push("mes-extra");
  inventory.groups[0]!.mouldCount = 2;
  const linkedIds = sourceLinkedMouldIds(inventory);
  assert.equal(linkedIds.size, 1);
  assert.deepEqual([...linkedIds], ["mes-1"]);
  const grouped = inventoryMoulds(inventory, "SVC", [{ instanceId: "mes-1" }, { instanceId: "mes-extra" }]);
  assert.deepEqual(grouped.filter((mould) => !linkedIds.has(mould.instanceId)), [{ instanceId: "mes-extra" }]);
  assert.equal(storageInventoryCount(inventory, "SVC"), 3);
  assert.equal(sourceLinkedMouldIds(null).size, 0);
});

test("inventory lists use server groups without reclassifying ABCS or repair status", () => {
  const inventory = normalizeStorageInventory(payload)!;
  const moulds = [
    { instanceId: "mes-1", location: "A1-1", summaryCategory: "repair" },
    { instanceId: "mes-2", location: "天路", summaryCategory: "offsite" },
    { instanceId: "mes-2", location: "天路", summaryCategory: "offsite" },
    { instanceId: "mes-4", location: "S1-1", summaryCategory: "storage" },
  ];
  assert.deepEqual(inventoryMoulds(inventory, "SVC", moulds).map((row) => row.instanceId), ["mes-1"]);
  assert.deepEqual(inventoryMoulds(inventory, "TIANLU", moulds).map((row) => row.instanceId), ["mes-2"]);
  assert.deepEqual(inventoryMoulds(null, "SVC", moulds), []);
});

test("source search finds rack, asset, part and source range without dropping duplicates", () => {
  const entries = normalizeStorageInventory(payload)!.entries;
  assert.equal(entries.filter((row) => inventoryEntryMatches(row, "ｎｄｉｆ００１")).length, 2);
  assert.equal(inventoryEntryMatches(entries[0]!, "p1"), true);
  assert.equal(inventoryEntryMatches(entries[0]!, "1-1"), true);
  assert.equal(inventoryEntryMatches(entries[0]!, "a9:j9"), true);
  assert.equal(inventoryEntryMatches(entries[0]!, "天路"), false);
});

test("detail inventory retains confirmation provenance and physical discrepancy", () => {
  assert.deepEqual(normalizeMouldInventory({ site: "SVC", basis: "confirmed_list", source_ranges: ["A9:J9", "A12:J12"], source_locations: ["A / 1-1", "B / 2-1"], confirmed_on: "2026-11-09", location_conflict: true }), {
    site: "SVC", basis: "confirmed_list", sourceRanges: ["A9:J9", "A12:J12"], sourceLocations: ["A / 1-1", "B / 2-1"], confirmedOn: "2026-11-09", locationConflict: true, lastMovement: null,
  });
  assert.equal(normalizeMouldInventory(undefined), null);
  assert.equal(normalizeMouldInventory({ site: "S" }), null);
});

test("last movement evidence keeps its date and ambiguity instead of claiming a confirmed position", () => {
  const inventory = normalizeMouldInventory({ site: "TIANLU", basis: "last_movement", last_movement: {
    occurred_at: "2026-09-20T01:00:00Z", to_location: "天路", from_location: "厂外", reason: "移出", time_quality: "event_time", ambiguous: true,
  } })!;
  assert.equal(inventory.basis, "last_movement");
  assert.equal(inventory.confirmedOn, null);
  assert.equal(inventory.lastMovement?.toLocation, "天路");
  assert.equal(inventory.lastMovement?.occurredAt, "2026-09-20T01:00:00Z");
  assert.equal(inventory.lastMovement?.ambiguous, true);
});
