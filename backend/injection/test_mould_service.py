from __future__ import annotations

from unittest.mock import Mock, patch

import requests

from django.core.cache import cache
from django.test import SimpleTestCase
from rest_framework.test import APIClient

from injection.mould_service import (
    CUSTOM_OBJECT_LIST_ENDPOINT,
    build_mould_board,
    build_mould_detail,
    build_choice_value_maps,
    discover_child_objects,
    enrich_mould_records,
    normalize_child_record,
    normalize_history_record,
    normalize_history_records,
    normalize_mould_record,
    normalize_resource_mould,
)
from injection import mould_service


def custom_record(
    instance_id: int,
    mould_code: str,
    location: str,
    *,
    status: str = "使用中",
    updated_at: int = 1_767_225_600_000,
):
    return {
        "instanceId": instance_id,
        "objectCode": "MOLD001__c",
        "updatedAt": updated_at,
        "fields": [
            {
                "fieldCode": "tenant_history_code",
                "fieldName": "履历编号",
                "fieldType": "TEXT",
                "fieldValue": mould_code,
            },
            {
                "fieldCode": "tenant_asset_code",
                "fieldName": "资产号",
                "fieldType": "TEXT",
                "fieldValue": f"ASSET-{instance_id}",
            },
            {
                "fieldCode": "tenant_location",
                "fieldName": "当前位置",
                "fieldType": "TEXT",
                "fieldValue": location,
            },
            {
                "fieldCode": "tenant_status",
                "fieldName": "当前状态",
                "fieldType": "SINGLE_CHOICE",
                "fieldValue": "1",
                "choiceValues": [{"name": status}],
            },
            {
                "fieldCode": "tenant_name",
                "fieldName": "模具名称",
                "fieldType": "TEXT",
                "fieldValue": f"Mould {instance_id}",
            },
        ],
    }


def resource_record(
    instance_id: int,
    *,
    resource_id: int | None = None,
    updated_at: int = 1_767_232_800_000,
    on_way_status=None,
):
    return {
        "id": resource_id or (9_000 + instance_id),
        "entityLinkCode": f"ASSET-{instance_id}",
        "currentOutputAmount": "1523",
        "currentOutputBatchAmount": 42,
        "lifespanStatus": {"code": 1, "message": "正常"},
        "maintenanceStatus": {"code": 0, "message": "正常"},
        "repairStatus": {"code": 0, "message": "正常"},
        "onWayStatus": (
            on_way_status
            if on_way_status is not None
            else {"code": 1, "message": "厂内"}
        ),
        "coverFileId": 77,
        "locations": [{"code": "RESOURCE-LOCATION", "level": 9}],
        "updatedAt": updated_at,
    }


class MouldTransformTests(SimpleTestCase):
    def test_parent_fields_are_resolved_by_field_name_not_tenant_code(self):
        result = normalize_mould_record(
            custom_record(1_736_127_906_878_176, "MOLD-0674", "C9-18")
        )

        self.assertEqual(result["instance_id"], "1736127906878176")
        self.assertEqual(result["mould_code"], "MOLD-0674")
        self.assertEqual(result["asset_code"], "ASSET-1736127906878176")
        self.assertEqual(result["location"]["code"], "C9-18")
        self.assertEqual(result["location_kind"], "storage")
        self.assertEqual(result["status"], "使用中")
        self.assertEqual(
            result["final_changed_at_source"],
            "blacklake.custom_object.updatedAt",
        )
        self.assertIsNone(result["position_changed_at"])

    def test_metadata_choice_codes_and_relation_values_become_display_labels(self):
        record = custom_record(1, "MOLD-0001", "1734992386288216")
        for field in record["fields"]:
            if field["fieldName"] == "当前状态":
                field.pop("choiceValues", None)
                field["fieldValue"] = "1734992386287343"
            elif field["fieldName"] == "模具名称":
                field["fieldValue"] = {
                    "id": "internal-related-id",
                    "orgId": "internal-org-id",
                    "mainProperty": "DISPLAY-NAME",
                }
        metadata = {
            "data": {
                "fields": [
                    {
                        "fieldCode": "tenant_location",
                        "fieldName": "当前位置",
                        "choiceValues": [
                            {
                                "choiceCode": "1734992386288216",
                                "choiceValue": "#1-850T",
                            }
                        ],
                    },
                    {
                        "fieldCode": "tenant_status",
                        "fieldName": "当前状态",
                        "choiceValues": [
                            {
                                "choiceCode": "1734992386287343",
                                "choiceValue": "使用中",
                            }
                        ],
                    },
                ]
            }
        }

        result = normalize_mould_record(
            record,
            choice_value_maps=build_choice_value_maps(metadata),
        )

        self.assertEqual(result["location_code"], "#1-850T")
        self.assertEqual(result["location_kind"], "machine")
        self.assertEqual(result["status"], "使用中")
        self.assertEqual(result["name"], "DISPLAY-NAME")

    def test_resource_enrichment_is_additive_and_never_replaces_custom_location(self):
        mould = normalize_mould_record(custom_record(1, "MOLD-0001", "C9-18"))

        enriched, stats, warnings = enrich_mould_records(
            [mould],
            [resource_record(1)],
        )

        self.assertEqual(warnings, [])
        self.assertTrue(stats["complete"])
        self.assertEqual(enriched[0]["resource_id"], "9001")
        self.assertEqual(enriched[0]["current_output_amount"], 1523)
        self.assertEqual(enriched[0]["location_code"], "C9-18")
        self.assertEqual(enriched[0]["location"]["code"], "C9-18")
        self.assertEqual(
            enriched[0]["resource_locations"][0]["code"],
            "RESOURCE-LOCATION",
        )
        self.assertEqual(
            enriched[0]["resource_provenance"]["field_sources"]["on_way_status"],
            "blacklake.resource_mold.list",
        )

    def test_resource_duplicate_join_is_not_guessed(self):
        mould = normalize_mould_record(custom_record(2, "MOLD-0002", "C9-18"))
        first = resource_record(2, resource_id=9010)
        second = resource_record(2, resource_id=9011)

        enriched, stats, warnings = enrich_mould_records(
            [mould],
            [first, second],
        )

        self.assertEqual(stats["duplicate_count"], 1)
        self.assertNotIn("resource_id", enriched[0])
        self.assertEqual(
            enriched[0]["resource_provenance"]["candidate_count"],
            2,
        )
        self.assertIn("resource_enrichment_duplicate:ASSET-2:2", warnings)

    def test_resource_normalizer_keeps_resource_updated_at_separate(self):
        normalized = normalize_resource_mould(resource_record(3))

        self.assertEqual(normalized["resource_id"], "9003")
        self.assertEqual(normalized["current_output_batch_amount"], 42)
        self.assertIsNotNone(normalized["resource_record_updated_at"])
        self.assertNotIn("position_changed_at", normalized)

    def test_summary_categories_are_mutually_exclusive_and_reconcile(self):
        moulds = [
            normalize_mould_record(
                custom_record(1, "MOLD-0001", "#1-850T", status="维修中")
            ),
            normalize_mould_record(
                custom_record(2, "MOLD-0002", "C9-18", status="维保中")
            ),
            normalize_mould_record(custom_record(3, "MOLD-0003", "#2-850T")),
            normalize_mould_record(custom_record(4, "MOLD-0004", "#3-1300T")),
            normalize_mould_record(custom_record(5, "MOLD-0005", "A-1")),
            normalize_mould_record(custom_record(6, "MOLD-0006", "UNKNOWN")),
        ]
        offsite_rows, _stats, _warnings = enrich_mould_records(
            [moulds[2]],
            [resource_record(3, on_way_status=3)],
        )
        moulds[2] = offsite_rows[0]

        summary, warnings = mould_service._summarize_moulds(moulds)

        self.assertEqual(warnings, [])
        self.assertEqual(summary["repair"], 1)
        self.assertEqual(summary["maintenance"], 1)
        self.assertEqual(summary["offsite"], 1)
        self.assertEqual(summary["mounted"], 1)
        self.assertEqual(summary["stored"], 1)
        self.assertEqual(summary["unknown"], 1)
        self.assertEqual(summary["classified_total"], summary["total"])
        self.assertTrue(summary["reconciled"])

    def test_on_way_label_precedes_conflicting_numeric_code(self):
        mould = normalize_mould_record(custom_record(7, "MOLD-0007", "#7-1300T"))
        enriched, _stats, _warnings = enrich_mould_records(
            [mould],
            [resource_record(7, on_way_status={"code": 3, "message": "厂内"})],
        )

        summary, warnings = mould_service._summarize_moulds(enriched)

        self.assertEqual(summary["mounted"], 1)
        self.assertEqual(summary["offsite"], 0)
        self.assertEqual(warnings, [])

    def test_numeric_only_detail_on_way_status_is_ambiguous(self):
        mould = normalize_mould_record(custom_record(8, "MOLD-0008", "#8-850T"))
        enriched, _stats, _warnings = enrich_mould_records(
            [mould],
            [resource_record(8, on_way_status=2)],
            source="blacklake.resource_mold.detail",
        )

        summary, warnings = mould_service._summarize_moulds(enriched)

        self.assertEqual(summary["mounted"], 1)
        self.assertEqual(summary["offsite"], 0)
        self.assertIn("summary_ambiguous_on_way_status", warnings)
        self.assertEqual(
            enriched[0]["resource_provenance"]["field_sources"]["on_way_status"],
            "blacklake.resource_mold.detail",
        )

    def test_child_rows_preserve_names_and_field_code_provenance(self):
        result = normalize_child_record(
            {
                "instanceId": 99,
                "objectCode": "MOVE001__c",
                "createdAt": 1_767_225_600_000,
                "fields": [
                    {
                        "fieldCode": "tenant_destination",
                        "fieldName": "目的地",
                        "fieldType": "TEXT",
                        "fieldValue": "#1-850T",
                    }
                ],
            }
        )

        self.assertEqual(result["instance_id"], "99")
        self.assertEqual(result["fields"]["目的地"], "#1-850T")
        self.assertEqual(
            result["field_provenance"]["目的地"]["field_code"],
            "tenant_destination",
        )

    def test_metadata_discovers_children_by_object_name(self):
        result = discover_child_objects(
            {
                "data": {
                    "sonObjects": [
                        {
                            "object": {
                                "objectName": "模具移动事项",
                                "objectCode": "MOVE001__c",
                            }
                        },
                        {
                            "object": {
                                "objectName": "生产数量",
                                "objectCode": "OUTPUT001__c",
                            }
                        },
                        {
                            "object": {
                                "objectName": "模具改造维修记录",
                                "objectCode": "REPAIR001__c",
                            }
                        },
                    ]
                }
            }
        )

        self.assertEqual(result["movement_history"]["object_code"], "MOVE001__c")
        self.assertEqual(
            result["production_history"]["object_code"], "OUTPUT001__c"
        )
        self.assertEqual(result["repair_history"]["object_code"], "REPAIR001__c")

    def test_movement_child_exposes_stable_screen_fields(self):
        result = normalize_history_record(
            "movement_history",
            {
                "instanceId": 77,
                "objectCode": "MOVE001__c",
                "fields": [
                    {
                        "fieldCode": "tenant_date",
                        "fieldName": "移动日期",
                        "fieldValue": 1_767_225_600_000,
                    },
                    {
                        "fieldCode": "tenant_destination",
                        "fieldName": "移动处",
                        "fieldValue": "#1-850T",
                    },
                    {
                        "fieldCode": "tenant_reason",
                        "fieldName": "移动理由",
                        "fieldValue": "生产计划",
                    },
                    {
                        "fieldCode": "tenant_owner",
                        "fieldName": "担当",
                        "fieldValue": "Operator",
                    },
                ],
            },
        )

        self.assertEqual(result["id"], "77")
        self.assertEqual(result["to_location"], "#1-850T")
        self.assertEqual(result["reason"], "生产计划")
        self.assertEqual(result["operator_name"], "Operator")
        self.assertEqual(result["time_quality"], "child_field")

    def test_production_child_exposes_custom_cumulative_shots(self):
        result = normalize_history_record(
            "production_history",
            {
                "instanceId": 78,
                "objectCode": "OUTPUT001__c",
                "fields": [
                    {"fieldName": "生产数量", "fieldValue": "1,523"},
                    {"fieldName": "累计生产数量", "fieldValue": "17,294"},
                ],
            },
        )

        self.assertEqual(result["quantity"], 1523)
        self.assertEqual(result["cumulative_quantity"], 17294)

    def test_production_child_expands_wj_month_columns(self):
        result = normalize_history_records(
            "production_history",
            {
                "instanceId": 79,
                "objectCode": "OUTPUT001__c",
                "createdAt": 1_780_894_440_463,
                "fields": [
                    {"fieldName": "年度", "fieldValue": "2026"},
                    {"fieldName": "总计", "fieldValue": "107,733"},
                    {"fieldName": "5月", "fieldValue": "27,241"},
                    {"fieldName": "6月", "fieldValue": "35,492"},
                    {"fieldName": "7月", "fieldValue": "45,000"},
                ],
            },
        )

        self.assertEqual(
            [row["period"] for row in result],
            ["2026-05", "2026-06", "2026-07"],
        )
        self.assertEqual(
            [row["quantity"] for row in result],
            [27241, 35492, 45000],
        )
        self.assertEqual(
            [row["cumulative_quantity"] for row in result],
            [27241, 62733, 107733],
        )
        self.assertTrue(all(row["unit"] == "Shot" for row in result))

    @patch("injection.mould_service.fetch_resource_mould_records")
    @patch("injection.mould_service.fetch_mould_metadata")
    @patch("injection.mould_service.search_mould_records")
    def test_board_contract_groups_machine_and_storage_locations(
        self, search_records, fetch_metadata, fetch_resources
    ):
        search_records.return_value = (
            [
                custom_record(1, "MOLD-0001", "#1-850T"),
                custom_record(2, "MOLD-0002", "C9-18"),
            ],
            [],
        )
        fetch_metadata.return_value = {
            "data": {
                "sonObjects": [
                    {"object": {"objectName": name, "objectCode": code}}
                    for name, code in (
                        ("模具移动事项", "MOVE001__c"),
                        ("生产数量", "OUTPUT001__c"),
                        ("模具改造维修记录", "REPAIR001__c"),
                    )
                ]
            }
        }
        fetch_resources.return_value = (
            [resource_record(1), resource_record(2)],
            [],
        )

        result = build_mould_board()

        self.assertEqual(result["summary"]["total"], 2)
        self.assertEqual(result["summary"]["mounted"], 1)
        self.assertEqual(result["summary"]["stored"], 1)
        self.assertEqual(result["summary"]["maintenance"], 0)
        self.assertEqual(result["summary"]["repair"], 0)
        self.assertTrue(result["summary"]["reconciled"])
        self.assertEqual(len(result["machines"]), 17)
        self.assertEqual(result["machines"][0]["location_code"], "#1-850T")
        self.assertEqual(result["machines"][0]["mould_count"], 1)
        self.assertEqual(result["data_freshness"]["mode"], "live")
        self.assertTrue(result["capabilities"]["repair_history"])
        self.assertTrue(result["capabilities"]["resource_enrichment"])
        self.assertTrue(result["capabilities"]["resource_enrichment_complete"])
        self.assertEqual(
            result["final_changed_at"],
            result["data_freshness"]["custom_object_latest_at"],
        )
        self.assertNotEqual(
            result["final_changed_at"],
            result["data_freshness"]["resource_latest_at"],
        )
        self.assertEqual(result["moulds"][0]["location_code"], "#1-850T")

    @patch("injection.mould_service.fetch_resource_mould_records")
    @patch("injection.mould_service.fetch_mould_metadata", return_value={})
    @patch("injection.mould_service.search_mould_records")
    def test_board_aggregates_resource_join_warnings(
        self, search_records, _fetch_metadata, fetch_resources
    ):
        search_records.return_value = (
            [custom_record(index, f"MOLD-{index:04d}", "C9-18") for index in range(1, 4)],
            [],
        )
        fetch_resources.return_value = ([], [])

        result = build_mould_board()

        self.assertIn("resource_enrichment_incomplete", result["warnings"])
        self.assertFalse(
            any(
                warning.startswith("resource_enrichment_unmatched:")
                for warning in result["warnings"]
            )
        )
        self.assertEqual(
            result["provenance"]["resource_enrichment"]["unmatched_count"],
            3,
        )
        self.assertTrue(
            any(
                warning.startswith("resource_enrichment_unmatched:")
                for warning in result["moulds"][0]["warnings"]
            )
        )

    @patch(
        "injection.mould_service.fetch_resource_mould_records",
        side_effect=mould_service.MouldServiceError("resource unavailable"),
    )
    @patch("injection.mould_service.fetch_mould_metadata", return_value={})
    @patch("injection.mould_service.search_mould_records")
    def test_board_survives_resource_api_failure(
        self, search_records, _fetch_metadata, _fetch_resources
    ):
        search_records.return_value = (
            [custom_record(1, "MOLD-0001", "C9-18")],
            [],
        )

        result = build_mould_board()

        self.assertEqual(result["summary"]["total"], 1)
        self.assertFalse(result["capabilities"]["resource_enrichment"])
        self.assertIn("resource_enrichment_unavailable", result["warnings"])

    @patch("injection.mould_service.fetch_resource_mould_detail")
    @patch("injection.mould_service.fetch_resource_mould_records")
    @patch("injection.mould_service._fetch_operation_logs")
    @patch("injection.mould_service._fetch_child_records")
    @patch("injection.mould_service.fetch_mould_metadata")
    @patch("injection.mould_service._fetch_mould_detail_record")
    def test_detail_contract_separates_record_and_position_change_times(
        self,
        fetch_detail,
        fetch_metadata,
        fetch_children,
        fetch_logs,
        fetch_resources,
        fetch_resource_detail,
    ):
        fetch_detail.return_value = custom_record(
            1_736_127_906_878_176,
            "MOLD-0674",
            "#1-850T",
            updated_at=1_767_229_200_000,
        )
        fetch_metadata.return_value = {
            "data": {
                "sonObjects": [
                    {"object": {"objectName": name, "objectCode": code}}
                    for name, code in (
                        ("模具移动事项", "MOVE001__c"),
                        ("生产数量", "OUTPUT001__c"),
                        ("模具改造维修记录", "REPAIR001__c"),
                    )
                ]
            }
        }

        def child_rows(*, main_instance_id, child_object_code):
            if child_object_code != "MOVE001__c":
                return [], []
            return [
                {
                    "instanceId": 88,
                    "objectCode": "MOVE001__c",
                    "createdAt": 1_767_225_600_000,
                    "fields": [
                        {"fieldName": "移动日期", "fieldValue": 1_767_225_600_000},
                        {"fieldName": "目的地", "fieldValue": "#1-850T"},
                    ],
                }
            ], []

        fetch_children.side_effect = child_rows
        fetch_logs.return_value = (
            [
                {
                    "logId": "log-1",
                    "loggedAt": 1_767_225_600_000,
                    "detailFields": [
                        {
                            "fieldName": "当前位置",
                            "fieldValueFrom": "C9-18",
                            "fieldValueTo": "#1-850T",
                        }
                    ],
                }
            ],
            [],
        )
        resource_list_row = resource_record(
            1_736_127_906_878_176,
            resource_id=9_999,
        )
        fetch_resources.return_value = ([resource_list_row], [])
        fetch_resource_detail.return_value = {
            **resource_list_row,
            "id": 9_999,
            "currentOutputAmount": "1523",
            # Numeric-only detail values are intentionally not interpreted
            # because the list/detail Swagger numeric meanings conflict.
            "onWayStatus": 2,
            "updatedAt": 1_767_232_800_000,
        }

        result = build_mould_detail("1736127906878176")

        self.assertEqual(len(result["movement_history"]), 1)
        self.assertIsInstance(result["production_history"], list)
        self.assertEqual(
            result["final_changed_at_source"],
            "blacklake.custom_object.updatedAt",
        )
        self.assertEqual(result["position_changed_at_source"], "operation_log")
        self.assertNotEqual(result["final_changed_at"], result["position_changed_at"])
        self.assertEqual(
            result["provenance"]["movement_history"]["object_code"],
            "MOVE001__c",
        )
        self.assertEqual(result["mould"]["current_output_amount"], 1523)
        self.assertEqual(result["mould"]["location_code"], "#1-850T")
        self.assertTrue(result["capabilities"]["resource_enrichment"])
        self.assertTrue(result["capabilities"]["resource_detail"])
        self.assertTrue(result["provenance"]["resource_detail"]["loaded"])
        self.assertEqual(
            result["provenance"]["resource_detail"]["on_way_status_source"],
            "blacklake.resource_mold.detail",
        )
        self.assertIn("resource_on_way_status_ambiguous", result["warnings"])
        self.assertEqual(
            result["final_changed_at"],
            result["data_freshness"]["custom_object_latest_at"],
        )
        self.assertEqual(
            result["data_freshness"]["source_latest_at"],
            result["data_freshness"]["resource_latest_at"],
        )
        fetch_resources.assert_called_once_with(
            entity_link_code="ASSET-1736127906878176"
        )
        fetch_resource_detail.assert_called_once_with("9999")

    @patch("injection.mould_service._fetch_operation_logs", return_value=([], []))
    @patch("injection.mould_service.fetch_mould_metadata", return_value={})
    @patch(
        "injection.mould_service.fetch_resource_mould_records",
        side_effect=mould_service.MouldServiceError("resource unavailable"),
    )
    @patch("injection.mould_service._fetch_mould_detail_record")
    def test_detail_survives_resource_api_failure(
        self,
        fetch_detail,
        _fetch_resources,
        _fetch_metadata,
        _fetch_logs,
    ):
        fetch_detail.return_value = custom_record(1, "MOLD-0001", "C9-18")

        result = build_mould_detail("1")

        self.assertEqual(result["mould"]["location_code"], "C9-18")
        self.assertFalse(result["capabilities"]["resource_enrichment"])
        self.assertFalse(result["capabilities"]["resource_detail"])
        self.assertIn("resource_enrichment_unavailable", result["warnings"])

    @patch("injection.mould_service._fetch_all_pages", return_value=([], []))
    def test_resource_list_uses_documented_entity_link_filter(self, fetch_pages):
        mould_service.fetch_resource_mould_records("ASSET-1")

        fetch_pages.assert_called_once_with(
            mould_service.RESOURCE_MOULD_LIST_ENDPOINT,
            {"entityLinkCode": "ASSET-1"},
        )

    @patch("injection.mould_service._post_blacklake")
    def test_resource_detail_accepts_standard_direct_record(self, post_blacklake):
        post_blacklake.return_value = {
            "code": 200,
            "data": {"id": 9999, "entityLinkCode": "ASSET-1"},
        }

        result = mould_service.fetch_resource_mould_detail("9999")

        self.assertEqual(result["id"], 9999)
        post_blacklake.assert_called_once_with(
            mould_service.RESOURCE_MOULD_DETAIL_ENDPOINT,
            {"id": 9999},
        )

    @patch("injection.mould_service.get_access_token", return_value="top-secret")
    @patch("injection.mould_service.requests.post")
    def test_upstream_request_errors_redact_query_tokens(self, post, _token):
        post.side_effect = requests.RequestException(
            "POST https://example.invalid/path?access_token=top-secret failed"
        )

        with self.assertRaises(mould_service.MouldServiceError) as raised:
            mould_service._post_blacklake(
                CUSTOM_OBJECT_LIST_ENDPOINT,
                {"objectCode": "MOLD001__c", "page": 1, "size": 1},
            )

        self.assertNotIn("top-secret", str(raised.exception))
        self.assertIn("access_token=[redacted]", str(raised.exception))

    @patch(
        "injection.mould_service.get_access_token",
        side_effect=["expired-token", "fresh-token"],
    )
    @patch("injection.mould_service.requests.post")
    def test_401_refreshes_once_without_changing_the_request_body(self, post, token):
        unauthorized = Mock(status_code=401)
        success = Mock(status_code=200)
        success.raise_for_status.return_value = None
        success.json.return_value = {"code": 200, "data": {"list": [], "total": 0}}
        post.side_effect = [unauthorized, success]

        payload = mould_service._post_blacklake(
            CUSTOM_OBJECT_LIST_ENDPOINT,
            {"objectCode": "MOLD001__c", "page": 1, "size": 1},
        )

        self.assertEqual(payload["code"], 200)
        self.assertEqual(post.call_count, 2)
        token.assert_any_call(force_refresh=True)
        self.assertEqual(post.call_args.kwargs["json"]["objectCode"], "MOLD001__c")


class MouldPublicViewTests(SimpleTestCase):
    sensitive_keys = {
        "authorization",
        "attachments",
        "attachment_ids",
        "cover_file_id",
        "creator_name",
        "field_provenance",
        "fields",
        "file_id",
        "object_code",
        "orgid",
        "operator_name",
        "product_photo",
        "provenance",
        "raw",
        "resource_cover_file_id",
        "resource_locations",
        "resource_provenance",
        "source",
        "source_fields",
        "upstream_metadata",
    }

    def setUp(self):
        cache.clear()

    def assert_sensitive_keys_absent(self, value):
        if isinstance(value, dict):
            for key, child in value.items():
                self.assertNotIn(str(key).casefold(), self.sensitive_keys)
                self.assert_sensitive_keys_absent(child)
        elif isinstance(value, list):
            for child in value:
                self.assert_sensitive_keys_absent(child)

    @patch("injection.mould_views.build_mould_board")
    def test_board_is_public_and_projects_only_dashboard_fields(self, build_board):
        build_board.return_value = {
            "status": "ok",
            "summary": {
                "total": 1,
                "mounted": 0,
                "stored": 1,
                "maintenance": 0,
                "repair": 0,
                "offsite": 0,
                "unknown": 0,
                "conflicts": 0,
                "upstream_metadata": "summary-secret",
            },
            "locations": [
                {
                    "code": "C9-18",
                    "label": "C9-18",
                    "kind": "storage",
                    "mould_count": 1,
                    "conflict": False,
                    "mould_instance_ids": ["1736127906878176"],
                    "raw": "location-secret",
                }
            ],
            "machines": [
                {
                    "number": 1,
                    "device_code": "850T-1",
                    "location_code": "#1-850T",
                    "label": "1호기 850T",
                    "tonnage": "850T",
                    "mould_count": 0,
                    "conflict": False,
                    "mould_instance_ids": [],
                }
            ],
            "moulds": [
                {
                    "instance_id": "1736127906878176",
                    "object_code": "MOLD001__c",
                    "mould_code": "MOLD-0674",
                    "asset_code": "ASSET-0674",
                    "name": "Public mould",
                    "drawing_no": {
                        "id": "internal-related-id",
                        "orgId": "internal-org-id",
                        "mainProperty": "DRAW-1",
                    },
                    "model": "MODEL-1",
                    "status": {
                        "code": "active",
                        "message": "使用中",
                        "Authorization": "enum-secret",
                    },
                    "classification": "production",
                    "cavity_count": 2,
                    "manufacturer": "Vendor A",
                    "serial_no": "SERIAL-1",
                    "current_output_amount": 10,
                    "current_output_batch_amount": 20,
                    "lifespan_status": {"code": 1, "message": "正常"},
                    "maintenance_status": {"code": 0, "message": "正常"},
                    "repair_status": {"code": 0, "message": "正常"},
                    "summary_category": "storage",
                    "location": {
                        "code": "C9-18",
                        "label": "C9-18",
                        "kind": "storage",
                        "mould_count": 1,
                        "conflict": False,
                        "raw": "nested-location-secret",
                    },
                    "final_changed_at": "2026-01-01T08:00:00+08:00",
                    "record_updated_at": "2026-01-01T08:00:00+08:00",
                    "position_changed_at": None,
                    "time_quality": "record_only",
                    "product_photo": {"fileId": "photo-secret"},
                    "cover_file_id": "cover-secret",
                    "source_fields": {"secret": "raw-field-secret"},
                    "resource_locations": [{"code": "upstream-secret"}],
                    "resource_provenance": {"Authorization": "bearer-secret"},
                }
            ],
            "final_changed_at": "2026-01-01T08:00:00+08:00",
            "data_freshness": {
                "status": "live",
                "fetched_at": "2026-01-01T08:01:00+08:00",
                "source_latest_at": "2026-01-01T08:00:00+08:00",
                "source": "blacklake-secret-source",
                "upstream_metadata": {"Authorization": "bearer-secret"},
            },
            "attachments": [{"id": "file-secret"}],
            "provenance": {"Authorization": "bearer-secret"},
        }
        client = APIClient()
        client.credentials(HTTP_AUTHORIZATION="Bearer invalid-public-token")

        response = client.get("/api/injection/moulds/board/")

        self.assertEqual(response.status_code, 200)
        self.assertIn("no-store", response["Cache-Control"])
        self.assertEqual(response.json()["moulds"][0]["mould_code"], "MOLD-0674")
        self.assertEqual(response.json()["moulds"][0]["drawing_no"], "DRAW-1")
        self.assertEqual(response.json()["moulds"][0]["location"]["code"], "C9-18")
        self.assertNotIn("device_code", response.json()["machines"][0])
        self.assert_sensitive_keys_absent(response.json())
        build_board.assert_called_once_with(quick_search="")

        cached_response = client.get("/api/injection/moulds/board/")
        self.assertEqual(cached_response.status_code, 200)
        build_board.assert_called_once_with(quick_search="")

    @patch("injection.mould_views.build_mould_detail")
    def test_detail_is_public_and_removes_files_people_and_raw_history(self, build_detail):
        build_detail.return_value = {
            "status": "ok",
            "mould": {
                "instance_id": "1736127906878176",
                "mould_code": "MOLD-0674",
                "asset_code": "ASSET-0674",
                "name": "Public mould",
                "location": {
                    "code": "C9-18",
                    "label": "C9-18",
                    "kind": "storage",
                },
                "cover_file_id": "cover-secret",
                "product_photo": {"fileId": "photo-secret"},
                "source_fields": {"secret": "raw-field-secret"},
                "resource_provenance": {"Authorization": "bearer-secret"},
            },
            "attachments": [
                {"id": "file-secret", "url": "https://example.invalid/private"}
            ],
            "movement_history": [
                {
                    "id": "movement-1",
                    "occurred_at": "2026-01-01T08:00:00+08:00",
                    "from_location": "A1-1",
                    "to_location": "C9-18",
                    "reason": "Move",
                    "operator_name": "Private Operator",
                    "time_quality": "child_field",
                    "fields": {"private": "movement-secret"},
                    "field_provenance": {"private": "movement-provenance"},
                }
            ],
            "production_history": [
                {
                    "id": "production-1",
                    "period": "2026-01",
                    "year": 2026,
                    "month": 1,
                    "quantity": 100,
                    "cumulative_quantity": 1000,
                    "unit": "shots",
                    "recorded_at": "2026-01-31T08:00:00+08:00",
                    "raw": "production-secret",
                }
            ],
            "repair_history": [
                {
                    "id": "repair-1",
                    "record_code": "R-1",
                    "requested_at": "2026-01-02T08:00:00+08:00",
                    "started_at": "2026-01-02T09:00:00+08:00",
                    "finished_at": "2026-01-02T10:00:00+08:00",
                    "type": "repair",
                    "content": "Replace component",
                    "vendor": "Vendor A",
                    "creator_name": "Private Creator",
                    "cumulative_output_amount": 1000,
                    "attachment_ids": ["attachment-secret"],
                    "fields": {"private": "repair-secret"},
                }
            ],
            "final_changed_at": "2026-01-01T08:00:00+08:00",
            "record_updated_at": "2026-01-01T08:00:00+08:00",
            "position_changed_at": "2026-01-01T07:00:00+08:00",
            "time_quality": "verified_event",
            "data_freshness": {
                "status": "live",
                "fetched_at": "2026-01-01T08:01:00+08:00",
                "source_latest_at": "2026-01-01T08:00:00+08:00",
                "source": "blacklake-secret-source",
            },
            "position_history": {"raw": "position-secret"},
            "provenance": {"Authorization": "bearer-secret"},
        }
        client = APIClient()
        client.credentials(HTTP_AUTHORIZATION="Bearer invalid-public-token")

        response = client.get("/api/injection/moulds/1736127906878176/")

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["mould"]["mould_code"], "MOLD-0674")
        self.assertEqual(body["movement_history"][0]["reason"], "Move")
        self.assertEqual(body["production_history"][0]["quantity"], 100)
        self.assertEqual(body["repair_history"][0]["vendor"], "Vendor A")
        self.assert_sensitive_keys_absent(body)
        build_detail.assert_called_once_with("1736127906878176")

        cached_response = client.get("/api/injection/moulds/1736127906878176/")
        self.assertEqual(cached_response.status_code, 200)
        build_detail.assert_called_once_with("1736127906878176")
