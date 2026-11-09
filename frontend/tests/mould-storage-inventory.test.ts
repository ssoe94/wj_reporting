import assert from "node:assert/strict";
import test from "node:test";
import {
  inventoryEntryMatches, inventoryMoulds, normalizeMouldInventory, normalizeStorageInventory, sourceLinkedMouldIds, sourceReferencedMouldIds, storageInventoryCount, storageInventoryUnit,
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
    site: "SVC", basis: "confirmed_list", sourceRanges: ["A9:J9", "A12:J12"], sourceLocations: ["A / 1-1", "B / 2-1"], confirmedOn: "2026-11-09", locationConflict: true, identityPending: false, confirmedMouldNos: [], lastMovement: null,
  });
  assert.equal(normalizeMouldInventory(undefined), null);
  assert.equal(normalizeMouldInventory({ site: "S" }), null);
});

function sharedAssetPayload() {
  const normalEntries = Array.from({ length: 33 }, (_, index) => ({
    entry_id: `normal-${index}`, asset_code: `ASSET-${index}`, instance_id: `mes-${index}`, match_status: "matched",
  }));
  const sharedEntries = [
    { entry_id: "svc-20261109-I20", mould_no: "NT2" },
    { entry_id: "svc-20261109-Q12", mould_no: "NT4" },
  ].map((entry) => ({
    ...entry, asset_code: "NDIF02767282", instance_id: null, match_status: "shared_asset_identity_pending",
    candidate_instance_ids: ["candidate-0512"], candidate_mould_codes: ["MOLD-0512"],
    confirmed_mould_nos: ["NT1", "NT2"], confirmed_mould_no: null,
  }));
  return {
    source: { ...payload.source, mould_rows: 35, unique_assets: 34, duplicate_assets: ["NDIF02767282"] },
    entries: [...normalEntries, ...sharedEntries],
    groups: [{ site: "SVC", mould_count: 34, entry_count: 35, instance_ids: [...normalEntries.map((entry) => entry.instance_id), "candidate-0512"] }],
    identity_confirmations: [{ asset_code: "NDIF02767282", physical_mould_count: 2, mould_nos: ["NT1", "NT2"], source_entry_ids: sharedEntries.map((entry) => entry.entry_id), confirmed_on: "2026-11-09", row_mould_nos: {} }],
    reconciliation: { physical_mould_count: 35, individually_linked_mould_count: 33, identity_pending_mould_count: 2 },
  };
}

test("confirmed physical mould count stays 35 although there are 34 asset numbers and MES candidates", () => {
  const inventory = normalizeStorageInventory(sharedAssetPayload())!;
  assert.equal(inventory.entries.length, 35);
  assert.equal(inventory.source.uniqueAssets, 34);
  assert.equal(storageInventoryCount(inventory, "SVC"), 35);
  assert.equal(storageInventoryUnit(inventory, "SVC"), "moulds");
  assert.equal(storageInventoryUnit(normalizeStorageInventory(payload), "SVC"), "rows");
  assert.equal(inventory.reconciliation?.individuallyLinkedMouldCount, 33);
  assert.equal(inventory.reconciliation?.identityPendingMouldCount, 2);
  assert.equal(sourceLinkedMouldIds(inventory).size, 33);
  assert.equal(sourceReferencedMouldIds(inventory).size, 34);
  const records = inventory.groups[0]!.instanceIds.map((instanceId) => ({ instanceId }));
  assert.deepEqual(inventoryMoulds(inventory, "SVC", records).filter((mould) => !sourceReferencedMouldIds(inventory).has(mould.instanceId)), []);
});

test("shared asset rows preserve original NT2/NT4 without guessing their actual NT1/NT2 mapping", () => {
  const inventory = normalizeStorageInventory(sharedAssetPayload())!;
  const pending = inventory.entries.filter((entry) => entry.matchStatus === "shared_asset_identity_pending");
  assert.deepEqual(pending.map((entry) => entry.mouldNo), ["NT2", "NT4"]);
  assert.deepEqual(pending.map((entry) => entry.confirmedMouldNo), [null, null]);
  assert.deepEqual(pending.map((entry) => entry.instanceId), [null, null]);
  assert.deepEqual(pending[0]!.confirmedMouldNos, ["NT1", "NT2"]);
  assert.deepEqual(pending[0]!.candidateMouldCodes, ["MOLD-0512"]);
  assert.deepEqual(inventory.identityConfirmations[0]?.rowMouldNos, {});
  assert.equal(inventoryEntryMatches(pending[0]!, "NT1"), true);
  assert.equal(inventoryEntryMatches(pending[0]!, "MOLD-0512"), true);
  pending[0]!.instanceId = "candidate-0512";
  assert.equal(sourceLinkedMouldIds(inventory).has("candidate-0512"), false);
});

test("an explicitly confirmed row mapping stays separate from the source and unresolved MES identity", () => {
  const raw = sharedAssetPayload();
  const inventory = normalizeStorageInventory({
    ...raw,
    entries: raw.entries.map((entry) => entry.entry_id === "svc-20261109-I20" ? { ...entry, confirmed_mould_no: "NT1" } : entry),
    identity_confirmations: [{ ...raw.identity_confirmations[0], row_mould_nos: { "svc-20261109-I20": "NT1" } }],
  })!;
  const entry = inventory.entries.find((row) => row.entryId === "svc-20261109-I20")!;
  assert.equal(entry.mouldNo, "NT2");
  assert.equal(entry.confirmedMouldNo, "NT1");
  assert.equal(entry.instanceId, null);
  assert.equal(entry.matchStatus, "shared_asset_identity_pending");
  assert.equal(inventory.identityConfirmations[0]?.rowMouldNos[entry.entryId], "NT1");
  const detail = normalizeMouldInventory({ site: "SVC", identity_pending: true, confirmed_mould_nos: ["NT1", "NT2"] })!;
  assert.equal(detail.identityPending, true);
  assert.deepEqual(detail.confirmedMouldNos, ["NT1", "NT2"]);
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
