import unittest

from injection.mould_events import (
    MACHINE_LOCATION_CODES,
    classify_location,
    normalize_location,
    normalize_position_history,
)


T1 = 1_750_000_000_000
T2 = T1 + 60_000


class MouldLocationClassificationTests(unittest.TestCase):
    def test_machine_classification_uses_exact_wj_allowlist(self):
        self.assertEqual(len(MACHINE_LOCATION_CODES), 17)
        self.assertEqual(classify_location("#1-850T"), "machine")
        self.assertEqual(classify_location("#17-1200T"), "machine")
        self.assertEqual(classify_location("850T-1"), "unknown")
        self.assertEqual(classify_location("#1-850t"), "unknown")

    def test_storage_classification_uses_known_cell_grammars(self):
        self.assertEqual(classify_location("A1-1"), "storage")
        self.assertEqual(classify_location("C9-18"), "storage")
        self.assertEqual(classify_location("S3-7"), "storage")
        self.assertEqual(classify_location("A-1"), "storage")
        self.assertEqual(classify_location("a1-1"), "unknown")
        self.assertEqual(classify_location("A1"), "unknown")

    def test_location_hierarchy_uses_deepest_level(self):
        locations = [
            {"code": "WAREHOUSE", "name": "금형 창고", "level": 1},
            {"code": "C9-18", "name": "C9-18", "level": 3},
            {"code": "C-ZONE", "name": "C 구역", "level": 2},
        ]

        self.assertEqual(normalize_location(locations), "C9-18")
        self.assertEqual(classify_location(locations), "storage")


class MouldPositionHistoryTests(unittest.TestCase):
    def test_storage_to_machine_creates_mount_from_logged_at(self):
        result = normalize_position_history(
            [
                {
                    "logId": 101,
                    "loggedAt": T1,
                    "fieldValueFrom": "C9-18",
                    "fieldValueTo": "#1-850T",
                }
            ],
            current_location="#1-850T",
        )

        self.assertEqual([event["type"] for event in result["events"]], ["mount"])
        self.assertEqual(result["last_changed_at"], T1)
        self.assertEqual(result["last_changed_source"], "operation_log")
        self.assertEqual(result["current_state"], "mounted")
        self.assertEqual(result["quality"], "verified")

    def test_machine_to_storage_creates_unmount(self):
        result = normalize_position_history(
            [
                {
                    "logId": 102,
                    "loggedAt": T1,
                    "fieldValueFrom": "#1-850T",
                    "fieldValueTo": "A1-1",
                }
            ],
            current_location="A1-1",
        )

        self.assertEqual([event["type"] for event in result["events"]], ["unmount"])
        self.assertEqual(result["current_state"], "stored")

    def test_machine_to_machine_creates_atomic_unmount_and_mount(self):
        result = normalize_position_history(
            [
                {
                    "logId": 103,
                    "loggedAt": T1,
                    "fieldValueFrom": "#1-850T",
                    "fieldValueTo": "#17-1200T",
                }
            ],
            current_location="#17-1200T",
        )

        self.assertEqual(
            [event["type"] for event in result["events"]],
            ["unmount", "mount"],
        )
        self.assertTrue(all(event["occurred_at"] == T1 for event in result["events"]))

    def test_latest_verified_log_or_replacement_timestamp_wins(self):
        result = normalize_position_history(
            [
                {
                    "logId": 104,
                    "loggedAt": T1,
                    "fieldValueFrom": "A1-1",
                    "fieldValueTo": "#1-850T",
                }
            ],
            [
                {
                    "id": "replacement-1",
                    "createdAt": T2,
                    "previousLocation": "#1-850T",
                    "currentLocation": "C9-18",
                }
            ],
            current_location="C9-18",
        )

        self.assertEqual(result["last_changed_at"], T2)
        self.assertEqual(result["last_changed_source"], "replacement_record")
        self.assertEqual([event["type"] for event in result["events"]], ["mount", "unmount"])

    def test_parent_updated_at_is_preserved_but_never_used_as_event_fallback(self):
        result = normalize_position_history(
            operation_logs=[],
            replacement_records=[],
            current_location="#1-850T",
            record_updated_at=T2,
        )

        self.assertEqual(result["record_updated_at"], T2)
        self.assertIsNone(result["last_changed_at"])
        self.assertIsNone(result["last_changed_source"])
        self.assertEqual(result["events"], [])
        self.assertEqual(result["current_state"], "mounted")
        self.assertEqual(result["quality"], "partial")
        self.assertIn("missing_position_history", result["warnings"])

    def test_invalid_or_ambiguous_record_returns_warning_and_partial_quality(self):
        result = normalize_position_history(
            [
                {
                    "logId": 105,
                    "loggedAt": "not-a-timestamp",
                    "fieldValueFrom": "A1-1",
                    "fieldValueTo": "#1-850T",
                },
                {
                    "logId": 106,
                    "loggedAt": T2,
                    "fieldValueFrom": "unmapped-old",
                    "fieldValueTo": "#1-850T",
                },
            ],
            current_location="#1-850T",
        )

        self.assertEqual(result["last_changed_at"], T2)
        self.assertEqual(result["events"][0]["type"], "mount")
        self.assertEqual(result["events"][0]["quality"], "partial")
        self.assertEqual(result["quality"], "partial")
        self.assertIn("invalid_operation_log_timestamp:105", result["warnings"])
        self.assertIn("unknown_from_location:106", result["warnings"])

    def test_log_detail_fields_only_uses_location_change(self):
        result = normalize_position_history(
            [
                {
                    "logId": 107,
                    "loggedAt": T1,
                    "detailFields": [
                        {
                            "fieldName": "备注",
                            "fieldValueFrom": "old",
                            "fieldValueTo": "new",
                        },
                        {
                            "fieldName": "当前位置",
                            "fieldValueFrom": "C9-18",
                            "fieldValueTo": "#1-850T",
                        },
                    ],
                }
            ],
            current_location="#1-850T",
        )

        self.assertEqual(len(result["events"]), 1)
        self.assertEqual(result["events"][0]["type"], "mount")

    def test_current_location_mismatch_is_reported(self):
        result = normalize_position_history(
            [
                {
                    "logId": 108,
                    "loggedAt": T1,
                    "fieldValueFrom": "A1-1",
                    "fieldValueTo": "#1-850T",
                }
            ],
            current_location="C9-18",
        )

        self.assertEqual(result["current_state"], "stored")
        self.assertEqual(result["quality"], "partial")
        self.assertIn("history_current_location_mismatch", result["warnings"])


if __name__ == "__main__":
    unittest.main()
