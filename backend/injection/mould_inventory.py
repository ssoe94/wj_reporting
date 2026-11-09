"""Read-only, source-traceable storage inventory alongside MES location/status.

The dated SVC confirmation is a WJ display overlay, never a MES movement or
another mould master. Source rows stay separate from unique MES instances.
"""

from __future__ import annotations

import copy
import json
import re
from collections import defaultdict
from collections.abc import Mapping
from datetime import datetime, time
from functools import lru_cache
from pathlib import Path
from zoneinfo import ZoneInfo

from .mould_events import canonical_machine_location

SITES = ("SVC", "TIANLU", "OTHER", "UNCONFIRMED")
_ABCS = re.compile(r"^[ABCS]\d*-\d+$", re.IGNORECASE)
_TIANLU = re.compile(r"天路|(?<![A-Z0-9])TIAN\s*LU(?![A-Z0-9])", re.IGNORECASE)
_SVC = re.compile(r"(?<![A-Z0-9])SVC(?![A-Z0-9])", re.IGNORECASE)
_GENERIC = {"", "厂外", "廠外", "外部", "外协", "外協", "外借", "在途", "厂内", "廠內",
            "외부", "외주", "미확인", "unknown", "unconfirmed", "offsite", "outside", "external", "-"}


@lru_cache(maxsize=1)
def _catalog():
    return json.loads((Path(__file__).parent / "data" / "mould_svc_20261109.json").read_text(encoding="utf-8"))


def _key(value):
    return str(value or "").strip().upper()


def _identity_confirmation(asset):
    return next((value for value in _catalog().get("identity_confirmations", [])
                 if _key(value["asset_code"]) == _key(asset)), None)


def latest_movement(history):
    """Last dated destination, with ties/missing actual dates kept unresolved.

    Input/creation dates cannot establish when a physical move occurred. No
    record-id or array-order tie breaker is a chronological observation.
    """
    if not isinstance(history, list) or not history:
        return None
    dated = []
    uncertain_date = False
    for row in history:
        if not isinstance(row, Mapping):
            continue
        try:
            at = datetime.fromisoformat(str(row.get("occurred_at") or "").replace("Z", "+00:00"))
            if at.tzinfo is None or row.get("time_quality") != "child_field":
                uncertain_date = True
                continue
            dated.append((at, row))
        except ValueError:
            uncertain_date = True
    if not dated:
        return {"occurred_at": None, "to_location": None, "from_location": None,
                "reason": None, "time_quality": "unknown", "ambiguous": True}
    latest_at = max(at for at, _ in dated)
    rows = [row for at, row in dated if at == latest_at]
    destinations = {_key(row.get("to_location")) for row in rows}
    ambiguous = uncertain_date or len(destinations) != 1 or "" in destinations
    row = rows[0]
    return {
        "occurred_at": latest_at.isoformat(),
        "to_location": None if ambiguous else str(row.get("to_location") or "").strip(),
        "from_location": str(row.get("from_location") or "").strip() if len(rows) == 1 else None,
        "reason": str(row.get("reason") or "").strip() if len(rows) == 1 else None,
        "time_quality": "unknown" if uncertain_date else "child_field",
        "ambiguous": ambiguous,
    }


def _location_site(mould):
    location = mould.get("location")
    location = location if isinstance(location, Mapping) else {}
    code = str(location.get("code") or "").strip()
    # Coordinates/mounted positions outrank a broad parent label such as SVC.
    if _ABCS.fullmatch(code) or canonical_machine_location(code) or location.get("kind") == "machine":
        return None
    labels = [str(location.get(key) or "").strip() for key in (
        "code", "label", "parent_code", "parent_label", "zone_code", "zone_label",
    )]
    text = " ".join(labels)
    if _TIANLU.search(text):
        return "TIANLU"
    if _SVC.search(text):
        return "SVC"
    return "OTHER" if any(value.casefold() not in _GENERIC for value in labels) else "UNCONFIRMED"


def _newer_position(mould):
    value = mould.get("position_changed_at")
    if not isinstance(value, str) or not value:
        return False
    try:
        changed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if changed.tzinfo is None:
            return False
        cutoff = datetime.combine(
            datetime.fromisoformat(_catalog()["source"]["confirmed_on"]).date(),
            time.max, tzinfo=ZoneInfo("Asia/Shanghai"),
        )
        return changed > cutoff
    except ValueError:
        return False


def _inventory(mould, entries):
    current_site = _location_site(mould)
    movement = mould.get("last_movement")
    movement = movement if isinstance(movement, Mapping) else None
    from_history = False
    if current_site == "UNCONFIRMED" and movement and not movement.get("ambiguous"):
        destination = str(movement.get("to_location") or "")
        # A last return to WJ cannot explain a currently outside mould. Keep
        # that disagreement unresolved, but show the last recorded destination.
        if not re.search(r"万佳|萬佳|(?<![A-Z])WJ(?![A-Z])", destination, re.IGNORECASE):
            historical_site = _location_site({"location": {"code": destination}})
            if historical_site in {"SVC", "TIANLU", "OTHER"}:
                current_site = historical_site
                from_history = True
    newer_position = _newer_position(mould)
    if movement and not movement.get("ambiguous"):
        newer_position = newer_position or _newer_position({"position_changed_at": movement.get("occurred_at")})
    # Retain a conflicting explicit position rather than claiming the sheet is
    # a live move. Generic outside/warehouse positions can be refined by it.
    conflict = bool(entries) and (
        current_site is None or current_site == "TIANLU"
        or (newer_position and current_site != "SVC")
    )
    use_confirmation = bool(entries) and not newer_position
    identity = _identity_confirmation(mould.get("asset_code"))
    return {
        "site": "SVC" if use_confirmation else current_site,
        "basis": "confirmed_list" if use_confirmation else (
            "last_movement" if from_history else "unconfirmed" if current_site == "UNCONFIRMED" else "mes_location"
        ),
        "source_ranges": [entry["source_range"] for entry in entries],
        "source_locations": [f'{entry["rack"]} / {entry["position"]}' for entry in entries],
        "confirmed_on": _catalog()["source"]["confirmed_on"] if entries else None,
        "location_conflict": conflict,
        "last_movement": copy.deepcopy(movement),
        "identity_pending": identity is not None,
        "confirmed_mould_nos": list(identity["mould_nos"]) if identity else [],
    }


def decorate_inventory_board(payload):
    """Decorate every read, including old snapshots, without changing sources."""
    result = copy.deepcopy(dict(payload))
    moulds = [row for row in result.get("moulds", []) if isinstance(row, dict)]
    by_asset = defaultdict(list)
    for mould in moulds:
        asset = _key(mould.get("asset_code"))
        if asset and mould.get("instance_id"):
            by_asset[asset].append(mould)
    catalog = _catalog()
    by_source_asset = defaultdict(list)
    for entry in catalog["entries"]:
        by_source_asset[_key(entry["asset_code"])].append(entry)

    groups = {site: set() for site in SITES}
    for mould in moulds:
        asset = _key(mould.get("asset_code"))
        entries = by_source_asset.get(asset, []) if len(by_asset[asset]) == 1 else []
        mould["inventory"] = _inventory(mould, entries)
        site = mould["inventory"]["site"]
        if site in groups and mould.get("instance_id"):
            groups[site].add(str(mould["instance_id"]))

    entries = []
    for source in catalog["entries"]:
        entry = copy.deepcopy(source)
        candidates = by_asset[_key(entry["asset_code"])]
        matched = candidates[0] if len(candidates) == 1 else None
        entry.update({
            "instance_id": str(matched["instance_id"]) if matched else None,
            "match_status": ("duplicate_source_asset" if len(by_source_asset[_key(entry["asset_code"])]) > 1 else "matched")
                if matched else ("ambiguous" if candidates else "unmatched"),
            "record_location": str((matched.get("location") or {}).get("code") or "") if matched else "",
            "location_conflict": matched["inventory"]["location_conflict"] if matched else False,
        })
        identity = _identity_confirmation(entry["asset_code"])
        if identity and entry["entry_id"] in identity["source_entry_ids"]:
            # A shared asset number identifies candidate records, not which
            # physical NT1/NT2 owns their usage or movement history. Never attach
            # that record as an individually verified link to either source row.
            entry.update({
                "instance_id": None,
                "match_status": "shared_asset_identity_pending",
                "candidate_instance_ids": sorted({str(row["instance_id"]) for row in candidates}),
                "candidate_mould_codes": sorted({str(row.get("mould_code") or "") for row in candidates} - {""}),
                "confirmed_mould_nos": list(identity["mould_nos"]),
                "confirmed_mould_no": identity["row_mould_nos"].get(entry["entry_id"]),
                "record_location": "",
                "location_conflict": False,
            })
        entries.append(entry)
    physical_count = 0
    for asset, source_rows in by_source_asset.items():
        identity = _identity_confirmation(asset)
        if len(source_rows) > 1 and identity is None:
            physical_count = None
            break
        physical_count += identity["physical_mould_count"] if identity else 1
    result["storage_inventory"] = {
        "source": copy.deepcopy(catalog["source"]),
        "identity_confirmations": copy.deepcopy(catalog.get("identity_confirmations", [])),
        "reconciliation": {
            "physical_mould_count": physical_count,
            "individually_linked_mould_count": sum(entry["match_status"] == "matched" for entry in entries),
            "identity_pending_mould_count": sum(entry["match_status"] == "shared_asset_identity_pending" for entry in entries),
            "unmatched_mould_count": sum(entry["match_status"] == "unmatched" for entry in entries),
        },
        "entries": entries,
        "groups": [{
            "site": site, "mould_count": len(groups[site]),
            "entry_count": len(entries) if site == "SVC" else len(groups[site]),
            "instance_ids": sorted(groups[site]),
        } for site in SITES],
    }
    return result


def decorate_inventory_detail(payload, *, moulds=None):
    result = copy.deepcopy(dict(payload))
    mould = result.get("mould")
    if isinstance(mould, dict):
        if "movement_history" in result:
            mould["last_movement"] = latest_movement(result.get("movement_history"))
        entries = [entry for entry in _catalog()["entries"]
                   if _key(entry["asset_code"]) == _key(mould.get("asset_code"))]
        if isinstance(moulds, list):
            candidates = [row for row in moulds if isinstance(row, Mapping)
                          and _key(row.get("asset_code")) == _key(mould.get("asset_code"))]
            if len(candidates) > 1 or (candidates and str(candidates[0].get("instance_id")) != str(mould.get("instance_id"))):
                entries = []
        mould["inventory"] = _inventory(mould, entries)
    return result
