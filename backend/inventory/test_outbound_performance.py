from __future__ import annotations

from datetime import date, datetime
from unittest.mock import MagicMock, call, patch

from django.core.cache import cache
from django.test import SimpleTestCase, TestCase

from inventory.services.outbound_performance import (
    OUTBOUND_ORDER_LIST_ENDPOINT,
    OutboundPerformanceError,
    SHANGHAI_TZ,
    _classify_order,
    _post_mes,
    _quantity_unit,
    _status_label,
    get_outbound_performance,
)
from inventory.mes import MES_BASE_URL


TARGET_DATE = date(2026, 8, 10)


def _at(year: int, month: int, day: int, hour: int = 12) -> int:
    return int(
        datetime(year, month, day, hour, tzinfo=SHANGHAI_TZ).timestamp() * 1000
    )


def _row(
    row_id: int,
    code: str,
    plan_time: int,
    *,
    plan=100,
    done=80,
    unit="个",
    **overrides,
):
    payload = {
        "id": row_id,
        "outboundOrderId": row_id * 10,
        "lineNo": 1,
        "code": code,
        "planTime": plan_time,
        "bizType": 1,
        "bizStatus": 4,
        "wareHouse": {"code": "Product", "name": "成品仓库"},
        "planAmount": plan,
        "doneAmount": done,
        "unit": {"name": unit},
    }
    payload.update(overrides)
    return payload


def _official_order(
    order_id: int,
    code: str,
    plan_time: int,
    *,
    items,
    **overrides,
):
    payload = {
        "id": order_id,
        "code": code,
        "planTime": plan_time,
        "bizType": {"code": 1, "message": "销售出库"},
        "bizStatus": {"code": 4, "message": "已关闭"},
        "wareHouse": {
            "id": 81,
            "code": "Product",
            "name": "成品仓库",
        },
        "items": items,
    }
    payload.update(overrides)
    return payload


class OutboundPerformanceNormalizationTests(SimpleTestCase):
    def test_order_classification_uses_exact_tokens_and_aliases(self):
        self.assertEqual(_classify_order("20260810LGENT-JIT"), ("JIT", None))
        self.assertEqual(_classify_order("20260810LGENT-RS-1-CKD"), ("CSKD", None))
        self.assertEqual(_classify_order("20260810-LGENT-CSD"), ("CSKD", None))
        self.assertEqual(
            _classify_order("20260810-JIT-CSKD"),
            (None, "classification_conflict"),
        )
        # A substring is intentionally not enough: this prevents accidental
        # classifications such as a model/customer name containing JIT.
        self.assertEqual(
            _classify_order("20260810-LGENTJIT"),
            (None, "classification_unclassified"),
        )

    def test_unit_evidence_accepts_piece_name_with_opaque_codes(self):
        row = {
            "unit": {"code": "tenant-unit-17"},
            "material": {
                "baseInfo": {"unit": {"code": "opaque-base", "name": "个"}},
                "unit": {"code": "opaque-material", "name": "个"},
            },
        }
        self.assertEqual(_quantity_unit(row, "10", "5"), ("EA", None))
        row["unit"] = {"code": "EA", "name": "kg"}
        self.assertEqual(
            _quantity_unit(row, "10", "5"),
            (None, "unit_mixed_or_incompatible"),
        )

    def test_unknown_outbound_status_is_not_treated_as_valid(self):
        self.assertEqual(_status_label({"code": 4, "message": "已关闭"}), "closed")
        self.assertIsNone(_status_label(999))
        self.assertIsNone(_status_label("mystery-state"))

    @patch("inventory.services.outbound_performance.requests.post")
    @patch("inventory.services.outbound_performance.get_access_token")
    def test_openapi_request_reuses_shared_mes_token_and_refresh_path(
        self,
        get_token,
        post,
    ):
        get_token.side_effect = ["same-app-token", "refreshed-same-app-token"]
        unauthorized = post.return_value
        successful = type(unauthorized)()
        unauthorized.status_code = 401
        successful.status_code = 200
        successful.json.return_value = {"code": 200, "data": {"list": [], "total": 0}}
        post.side_effect = [unauthorized, successful]

        body = {"page": 1, "size": 1}
        self.assertEqual(_post_mes(body)["code"], 200)

        self.assertEqual(
            get_token.call_args_list,
            [call(), call(force_refresh=True)],
        )
        self.assertEqual(
            post.call_args_list[0].args[0],
            f"{MES_BASE_URL}{OUTBOUND_ORDER_LIST_ENDPOINT}?access_token=same-app-token",
        )
        self.assertEqual(
            post.call_args_list[1].args[0],
            f"{MES_BASE_URL}{OUTBOUND_ORDER_LIST_ENDPOINT}?access_token=refreshed-same-app-token",
        )
        self.assertEqual(post.call_args_list[1].kwargs["json"], body)

    @patch("inventory.services.outbound_performance.requests.post")
    @patch("inventory.services.outbound_performance.get_access_token")
    def test_http_200_expired_token_body_refreshes_once(self, get_token, post):
        get_token.side_effect = ["expired-token", "refreshed-token"]
        expired = post.return_value
        successful = type(expired)()
        expired.status_code = 200
        expired.json.return_value = {
            "code": 401,
            "subCode": "ACCESS_TOKEN_EXPIRED",
            "message": "access token expired",
        }
        successful.status_code = 200
        successful.json.return_value = {
            "code": 200,
            "data": {"list": [], "total": 0},
        }
        post.side_effect = [expired, successful]

        self.assertEqual(_post_mes({"page": 1})["code"], 200)
        self.assertEqual(
            get_token.call_args_list,
            [call(), call(force_refresh=True)],
        )
        self.assertEqual(post.call_count, 2)

    @patch("inventory.services.outbound_performance.requests.post")
    @patch("inventory.services.outbound_performance.get_access_token")
    def test_observed_blacklake_auth_body_codes_refresh_once(self, get_token, post):
        cases = (
            (3401, "TOKEN_NOT_FOUND"),
            (400150, "USER-DOMAIN/SSO_TOKEN_FAIL"),
        )
        for code, sub_code in cases:
            with self.subTest(code=code, sub_code=sub_code):
                get_token.reset_mock()
                post.reset_mock()
                get_token.side_effect = ["expired-token", "refreshed-token"]
                expired = MagicMock(status_code=200)
                expired.json.return_value = {
                    "code": code,
                    "subCode": sub_code,
                    "message": "authentication token failed",
                }
                successful = MagicMock(status_code=200)
                successful.json.return_value = {
                    "code": 200,
                    "data": {"list": [], "total": 0},
                }
                post.side_effect = [expired, successful]

                self.assertEqual(_post_mes({"page": 1})["code"], 200)
                self.assertEqual(
                    get_token.call_args_list,
                    [call(), call(force_refresh=True)],
                )
                self.assertEqual(post.call_count, 2)

    @patch("inventory.services.outbound_performance.requests.post")
    @patch("inventory.services.outbound_performance.get_access_token")
    def test_permission_denied_body_never_refreshes_token(self, get_token, post):
        get_token.return_value = "same-app-token"
        post.return_value.status_code = 200
        post.return_value.json.return_value = {
            # Permission text wins even if the numeric/sub-code would normally
            # identify a stale token.
            "code": 3401,
            "subCode": "TOKEN_NOT_FOUND",
            "message": "应用无权限，接口未授权",
        }

        with self.assertRaises(OutboundPerformanceError):
            _post_mes({"page": 1})

        get_token.assert_called_once_with()
        self.assertEqual(post.call_count, 1)


class OutboundPerformanceServiceTests(TestCase):
    def setUp(self):
        cache.clear()

    @patch("inventory.services.outbound_performance._post_mes")
    def test_flattens_official_order_list_items_with_header_fields(self, post):
        post.return_value = {
            "code": 200,
            "data": {
                "total": 1,
                "list": [
                    {
                        "id": 7001,
                        "code": "20260810LGENT-JIT",
                        "planTime": _at(2026, 8, 10, 12),
                        "bizType": {"code": 1, "message": "销售出库"},
                        "bizStatus": {"code": 4, "message": "已关闭"},
                        "wareHouse": {
                            "id": 81,
                            "code": "Product",
                            "name": "成品仓库",
                        },
                        "items": [
                            {
                                "id": 9001,
                                "lineNo": 1,
                                "outboundOrderId": None,
                                "outboundOrderCode": "",
                                "planTime": None,
                                "bizType": {"code": None, "message": ""},
                                "bizStatus": {"code": None, "message": None},
                                "wareHouse": None,
                                "planAmount": "240",
                                "doneAmount": "381",
                                "unit": {"code": "tenant-unit-17", "name": "个"},
                                "material": {
                                    "baseInfo": {
                                        "id": 901,
                                        "code": "ABJ76769101",
                                        "name": "ABJ76769101 (MODEL-A)",
                                        "specification": "C/A",
                                    },
                                    "unit": {"code": "EA", "name": "个"},
                                },
                            }
                        ],
                    }
                ],
            },
        }

        payload, warnings, source, trace = get_outbound_performance(
            TARGET_DATE,
            force_refresh=True,
        )

        self.assertEqual(warnings, [])
        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["periods"]["today"]["JIT"]["target_qty"], 240)
        self.assertEqual(payload["periods"]["today"]["JIT"]["fulfilled_qty"], 381)
        item = payload["today_priority_items"][0]
        self.assertEqual(item["outbound_order_id"], "7001")
        self.assertEqual(item["outbound_order_code"], "20260810LGENT-JIT")
        self.assertEqual(item["material_code"], "ABJ76769101")
        self.assertEqual(item["status"], "closed")
        self.assertEqual(source["status"], "ok")
        self.assertEqual(payload["upstream_order_total"], 1)
        self.assertEqual(payload["orders_fetched"], 1)
        self.assertEqual(payload["raw_item_line_count"], 1)
        self.assertEqual(payload["pages_fetched"], 1)
        self.assertEqual(payload["item_shape_warning_count"], 0)
        self.assertEqual(payload["orders_with_empty_items"], 0)
        self.assertEqual(
            trace["source"],
            "BLACKLAKE inventory outbound_order._list items[]",
        )
        self.assertEqual(trace["upstream_order_total"], 1)
        self.assertEqual(trace["raw_item_line_count"], 1)

    @patch("inventory.services.outbound_performance.PAGE_SIZE", 1)
    @patch("inventory.services.outbound_performance._post_mes")
    def test_official_order_pagination_uses_order_total_not_item_total(self, post):
        def item(item_id, plan, done):
            return {
                "id": item_id,
                "lineNo": 1,
                "planAmount": str(plan),
                "doneAmount": str(done),
                "unit": {"code": "EA", "name": "个"},
            }

        post.side_effect = [
            {
                "code": 200,
                "data": {
                    "total": 2,
                    "list": [
                        _official_order(
                            7001,
                            "20260810LGENT-JIT",
                            _at(2026, 8, 10, 12),
                            items=[item(9001, 100, 80)],
                        )
                    ],
                },
            },
            {
                "code": 200,
                "data": {
                    "total": 2,
                    "list": [
                        _official_order(
                            7002,
                            "20260810LGENT-RS-1-CKD",
                            _at(2026, 8, 10, 13),
                            items=[item(9002, 50, 50)],
                        )
                    ],
                },
            },
        ]

        payload, warnings, _source, trace = get_outbound_performance(
            TARGET_DATE,
            force_refresh=True,
        )

        self.assertEqual(warnings, [])
        self.assertEqual(post.call_count, 2)
        self.assertEqual(post.call_args_list[0].args[0]["page"], 1)
        self.assertEqual(post.call_args_list[1].args[0]["page"], 2)
        self.assertEqual(payload["periods"]["today"]["JIT"]["target_qty"], 100)
        self.assertEqual(payload["periods"]["today"]["CSKD"]["target_qty"], 50)
        self.assertEqual(payload["upstream_order_total"], 2)
        self.assertEqual(payload["orders_fetched"], 2)
        self.assertEqual(payload["raw_item_line_count"], 2)
        self.assertEqual(payload["pages_fetched"], 2)
        self.assertEqual(trace["orders_fetched"], 2)

    @patch("inventory.services.outbound_performance._post_mes")
    def test_official_item_shape_defects_are_partial_when_valid_lines_remain(self, post):
        missing_items = _official_order(
            7001,
            "20260810LGENT-JIT",
            _at(2026, 8, 10, 9),
            items=[],
        )
        missing_items.pop("items")
        valid_item = {
            "id": 9004,
            "lineNo": 1,
            "planAmount": "40",
            "doneAmount": "30",
            "unit": {"code": "opaque", "name": "个"},
        }
        post.return_value = {
            "code": 200,
            "data": {
                "total": 4,
                "list": [
                    missing_items,
                    _official_order(
                        7002,
                        "20260810LGENT-JIT",
                        _at(2026, 8, 10, 10),
                        items={"not": "a-list"},
                    ),
                    _official_order(
                        7003,
                        "20260810LGENT-JIT",
                        _at(2026, 8, 10, 11),
                        items=[],
                    ),
                    _official_order(
                        7004,
                        "20260810LGENT-JIT",
                        _at(2026, 8, 10, 12),
                        items=["malformed", valid_item],
                    ),
                ],
            },
        }

        payload, warnings, source, trace = get_outbound_performance(
            TARGET_DATE,
            force_refresh=True,
        )

        self.assertEqual(payload["status"], "partial")
        self.assertEqual(source["status"], "partial")
        self.assertIn("outbound_order_items_missing", warnings)
        self.assertIn("outbound_order_items_not_list", warnings)
        self.assertIn("outbound_order_item_malformed", warnings)
        self.assertEqual(payload["periods"]["today"]["JIT"]["target_qty"], 40)
        self.assertEqual(payload["upstream_order_total"], 4)
        self.assertEqual(payload["orders_fetched"], 4)
        self.assertEqual(payload["raw_item_line_count"], 2)
        self.assertEqual(payload["pages_fetched"], 1)
        self.assertEqual(payload["item_shape_warning_count"], 3)
        self.assertEqual(payload["orders_with_empty_items"], 1)
        self.assertEqual(trace["item_shape_warning_count"], 3)

    @patch("inventory.services.outbound_performance._post_mes")
    def test_nonempty_orders_without_usable_items_are_unavailable_not_zero(self, post):
        missing_items = _official_order(
            7001,
            "20260810LGENT-JIT",
            _at(2026, 8, 10, 9),
            items=[],
        )
        missing_items.pop("items")
        post.return_value = {
            "code": 200,
            "data": {"total": 1, "list": [missing_items]},
        }

        payload, warnings, source, trace = get_outbound_performance(
            TARGET_DATE,
            force_refresh=True,
        )

        self.assertEqual(payload["status"], "unavailable")
        self.assertIsNone(payload["periods"]["today"]["JIT"]["target_qty"])
        self.assertEqual(source["status"], "error")
        self.assertIn("outbound_order_items_missing", warnings)
        self.assertIn("outbound_orders_have_no_usable_item_lines", warnings)
        self.assertEqual(payload["orders_fetched"], 1)
        self.assertEqual(payload["raw_item_line_count"], 0)
        self.assertEqual(payload["item_shape_warning_count"], 1)
        self.assertEqual(trace["orders_fetched"], 1)

    @patch("inventory.services.outbound_performance._post_mes")
    def test_malformed_official_order_list_shape_is_unavailable(self, post):
        post.return_value = {
            "code": 200,
            "data": {"total": 1, "list": ["not-an-order-object"]},
        }

        payload, warnings, source, trace = get_outbound_performance(
            TARGET_DATE,
            force_refresh=True,
        )

        self.assertEqual(payload["status"], "unavailable")
        self.assertEqual(source["status"], "error")
        self.assertIsNone(payload["periods"]["today"]["JIT"]["target_qty"])
        self.assertIn("outbound_order_list_shape_invalid", warnings)
        self.assertEqual(payload["pages_fetched"], 1)
        self.assertEqual(payload["item_shape_warning_count"], 1)
        self.assertEqual(trace["pages_fetched"], 1)

    @patch("inventory.services.outbound_performance._post_mes")
    def test_empty_item_arrays_are_audited_and_all_empty_is_unavailable(self, post):
        post.return_value = {
            "code": 200,
            "data": {
                "total": 1,
                "list": [
                    _official_order(
                        7001,
                        "20260810LGENT-JIT",
                        _at(2026, 8, 10, 9),
                        items=[],
                    )
                ],
            },
        }

        payload, warnings, _source, _trace = get_outbound_performance(
            TARGET_DATE,
            force_refresh=True,
        )

        self.assertEqual(payload["status"], "unavailable")
        self.assertIn("outbound_orders_have_no_usable_item_lines", warnings)
        self.assertEqual(payload["orders_with_empty_items"], 1)
        self.assertEqual(payload["item_shape_warning_count"], 0)
        self.assertEqual(payload["raw_item_line_count"], 0)

    @patch("inventory.services.outbound_performance._post_mes")
    def test_empty_item_order_is_valid_when_another_order_has_items(self, post):
        post.return_value = {
            "code": 200,
            "data": {
                "total": 2,
                "list": [
                    _official_order(
                        7001,
                        "20260810LGENT-JIT",
                        _at(2026, 8, 10, 9),
                        items=[],
                    ),
                    _official_order(
                        7002,
                        "20260810LGENT-JIT",
                        _at(2026, 8, 10, 10),
                        items=[
                            {
                                "id": 9002,
                                "lineNo": 1,
                                "planAmount": "20",
                                "doneAmount": "10",
                                "unit": {"name": "个"},
                            }
                        ],
                    ),
                ],
            },
        }

        payload, warnings, _source, _trace = get_outbound_performance(
            TARGET_DATE,
            force_refresh=True,
        )

        self.assertEqual(payload["status"], "ok")
        self.assertEqual(warnings, [])
        self.assertEqual(payload["orders_fetched"], 2)
        self.assertEqual(payload["orders_with_empty_items"], 1)
        self.assertEqual(payload["raw_item_line_count"], 1)
        self.assertEqual(payload["periods"]["today"]["JIT"]["target_qty"], 20)

    @patch("inventory.services.outbound_performance._post_mes")
    def test_zero_orders_is_valid_zero_with_explicit_audit_counts(self, post):
        post.return_value = {"code": 200, "data": {"total": 0, "list": []}}

        payload, warnings, _source, trace = get_outbound_performance(
            TARGET_DATE,
            force_refresh=True,
        )

        self.assertEqual(payload["status"], "ok")
        self.assertEqual(warnings, [])
        self.assertEqual(payload["periods"]["today"]["JIT"]["target_qty"], 0)
        self.assertEqual(payload["upstream_order_total"], 0)
        self.assertEqual(payload["orders_fetched"], 0)
        self.assertEqual(payload["raw_item_line_count"], 0)
        self.assertEqual(payload["pages_fetched"], 1)
        self.assertEqual(payload["item_shape_warning_count"], 0)
        self.assertEqual(trace["upstream_order_total"], 0)

    @patch("inventory.services.outbound_performance._post_mes")
    def test_aggregates_0800_plan_cohorts_and_scalar_or_nested_quantities(self, post):
        post.return_value = {
            "code": 200,
            "data": {
                "total": 5,
                "list": [
                    _row(
                        1,
                        "20260810LGENT-JIT",
                        _at(2026, 8, 10, 12),
                        plan="240",
                        done={"amount": {"amount": "381"}, "unit": {"name": "个"}},
                    ),
                    _row(
                        2,
                        "20260810LGENT-RS-1-CKD",
                        _at(2026, 8, 11, 7),
                        plan={"amount": "330", "unit": {"code": "PCS"}},
                        done="300",
                        unit="PCS",
                    ),
                    _row(
                        3,
                        "20260805LGENT-JIT",
                        _at(2026, 8, 5, 10),
                        plan=100,
                        done=80,
                    ),
                    _row(
                        4,
                        "20260715LGENT-CSD",
                        _at(2026, 7, 15, 9),
                        plan=50,
                        done=40,
                        bizType="销售出库",
                    ),
                    # The one broad upstream query also spans gaps between the
                    # three requested cohorts. Such rows are ignored without
                    # turning a valid result partial, even when unclassified.
                    _row(5, "OUT-202608020001", _at(2026, 8, 2, 12)),
                ],
            },
        }

        payload, warnings, source, trace = get_outbound_performance(
            TARGET_DATE,
            force_refresh=True,
        )

        self.assertEqual(payload["status"], "ok")
        self.assertEqual(warnings, [])
        self.assertEqual(payload["periods"]["today"]["start_at"], "2026-08-10T08:00:00+08:00")
        self.assertEqual(payload["periods"]["today"]["end_at"], "2026-08-11T08:00:00+08:00")
        self.assertEqual(
            payload["periods"]["today"]["JIT"],
            {
                "target_qty": 240,
                "fulfilled_qty": 381,
                "completion_rate": 158.8,
                "order_count": 1,
                "line_count": 1,
                "unit": "EA",
            },
        )
        self.assertEqual(payload["periods"]["today"]["CSKD"]["target_qty"], 330)
        self.assertEqual(payload["periods"]["previous_week"]["JIT"]["fulfilled_qty"], 80)
        self.assertEqual(payload["periods"]["previous_month"]["CSKD"]["target_qty"], 50)
        self.assertEqual(payload["accepted_line_count"], 4)
        self.assertEqual(payload["ignored_outside_period_line_count"], 1)
        self.assertIn("current cumulative doneAmount", payload["measurement_basis"]["historical_comparison"])
        self.assertEqual(source["status"], "ok")
        self.assertEqual(trace["rows_returned"], 4)
        request_body = post.call_args.args[0]
        self.assertEqual(request_body["planAtFrom"], _at(2026, 7, 1, 8))
        self.assertEqual(request_body["planAtTill"], _at(2026, 8, 11, 8) - 1)

    @patch("inventory.services.outbound_performance._post_mes")
    def test_builds_bounded_today_material_line_management_from_item_list(self, post):
        rows = [
            _row(
                1,
                "20260810LGENT-JIT",
                _at(2026, 8, 10, 12),
                plan=240,
                done=381,
                material={
                    "baseInfo": {
                        "id": 901,
                        "code": "ABJ76769101",
                        "name": "ABJ76769101 (MODEL-A)",
                        "specification": "C/A",
                    }
                },
            ),
            _row(
                2,
                "20260810LGENT-JIT",
                _at(2026, 8, 10, 10),
                plan=17,
                done=0,
                material={
                    "baseInfo": {
                        "id": 902,
                        "code": "ABJ76754403",
                        "name": "ABJ76754403 (MODEL-B)",
                        "specification": "C/A",
                    }
                },
            ),
            _row(
                3,
                "20260810LGENT-JIT",
                _at(2026, 8, 10, 17),
                plan=330,
                done=100,
                materialCode="ABJ76507601",
                materialName="ABJ76507601 (MODEL-C)",
                specification="C/A",
            ),
            _row(4, "20260810LGENT-JIT", _at(2026, 8, 10, 12), plan=20, done=20),
            _row(5, "20260810LGENT-RS-1-CKD", _at(2026, 8, 10, 12), plan=100, done=0),
            _row(6, "20260810LGENT-RS-1-CKD", _at(2026, 8, 10, 12), plan=50, done=60),
        ]
        post.return_value = {"code": 200, "data": {"total": len(rows), "list": rows}}

        payload, warnings, _source, trace = get_outbound_performance(
            TARGET_DATE,
            force_refresh=True,
        )

        self.assertEqual(warnings, [])
        jit = payload["today_detail_summary"]["JIT"]
        self.assertEqual(jit["pending_line_count"], 2)
        self.assertEqual(jit["complete_line_count"], 1)
        self.assertEqual(jit["over_line_count"], 1)
        self.assertEqual(jit["zero_fulfilled_line_count"], 1)
        self.assertEqual(jit["remaining_qty"], 247)
        self.assertEqual(jit["over_qty"], 141)
        self.assertEqual(jit["largest_pending"]["material_code"], "ABJ76507601")
        self.assertEqual(jit["largest_pending"]["remaining_qty"], 230)

        cskd = payload["today_detail_summary"]["CSKD"]
        self.assertEqual(cskd["pending_line_count"], 1)
        self.assertEqual(cskd["over_line_count"], 1)
        self.assertEqual(cskd["zero_fulfilled_line_count"], 1)
        self.assertEqual(cskd["remaining_qty"], 100)
        self.assertEqual(cskd["over_qty"], 10)

        priority = payload["today_priority_items"]
        self.assertEqual(len(priority), 6)
        # An earlier small shipment is more urgent than a larger later plan.
        self.assertEqual(priority[0]["material_code"], "ABJ76754403")
        self.assertEqual(priority[0]["fulfillment_state"], "pending")
        self.assertEqual(priority[1]["category"], "CSKD")
        screenshot_item = next(
            item for item in priority if item["material_code"] == "ABJ76769101"
        )
        self.assertEqual(screenshot_item["material_id"], "901")
        self.assertEqual(screenshot_item["material_name"], "ABJ76769101 (MODEL-A)")
        self.assertEqual(screenshot_item["specification"], "C/A")
        self.assertEqual(screenshot_item["target_qty"], 240)
        self.assertEqual(screenshot_item["fulfilled_qty"], 381)
        self.assertEqual(screenshot_item["remaining_qty"], 0)
        self.assertEqual(screenshot_item["variance_qty"], 141)
        self.assertEqual(screenshot_item["completion_rate"], 158.8)
        self.assertEqual(screenshot_item["fulfillment_state"], "over")
        self.assertEqual(screenshot_item["status"], "closed")
        self.assertEqual(
            trace["source"],
            "BLACKLAKE inventory outbound_order._list items[]",
        )

    @patch("inventory.services.outbound_performance._post_mes")
    def test_today_priority_items_are_bounded_to_ten(self, post):
        rows = [
            _row(
                row_id,
                "20260810LGENT-JIT",
                _at(2026, 8, 10, 12),
                plan=100 + row_id,
                done=0,
                materialCode=f"MODEL-{row_id:02d}",
            )
            for row_id in range(1, 13)
        ]
        post.return_value = {"data": {"total": len(rows), "list": rows}}

        payload, _warnings, _source, _trace = get_outbound_performance(
            TARGET_DATE,
            force_refresh=True,
        )

        self.assertEqual(len(payload["today_priority_items"]), 10)
        self.assertEqual(payload["today_priority_items"][0]["material_code"], "MODEL-12")
        self.assertEqual(payload["today_priority_items"][-1]["material_code"], "MODEL-03")

    @patch("inventory.services.outbound_performance._post_mes")
    def test_generic_outbound_orders_are_counted_as_expected_out_of_scope(self, post):
        rows = [
            _row(1, "A-JIT", _at(2026, 8, 10), plan=10, done=5),
            _row(2, "OUT-202608100001", _at(2026, 8, 10), plan=20, done=20),
            _row(
                3,
                "OUT-202608100001",
                _at(2026, 8, 10),
                plan=30,
                done=30,
                outboundOrderId=20,
            ),
        ]
        post.return_value = {"data": {"total": len(rows), "list": rows}}

        payload, warnings, source, trace = get_outbound_performance(
            TARGET_DATE,
            force_refresh=True,
        )

        self.assertEqual(payload["status"], "ok")
        self.assertEqual(warnings, [])
        self.assertEqual(payload["accepted_line_count"], 1)
        self.assertEqual(payload["excluded_line_count"], 0)
        self.assertEqual(payload["unclassified"], {"order_count": 1, "line_count": 2})
        self.assertEqual(source["status"], "ok")
        self.assertEqual(trace["rows_unclassified"], 2)

    @patch("inventory.services.outbound_performance._post_mes")
    def test_unknown_status_is_excluded_and_marks_result_partial(self, post):
        post.return_value = {
            "data": {
                "total": 1,
                "list": [
                    _row(
                        1,
                        "A-JIT",
                        _at(2026, 8, 10),
                        plan=10,
                        done=5,
                        bizStatus=999,
                    )
                ],
            }
        }

        payload, warnings, source, _trace = get_outbound_performance(
            TARGET_DATE,
            force_refresh=True,
        )

        self.assertEqual(payload["status"], "partial")
        self.assertEqual(source["status"], "partial")
        self.assertEqual(payload["accepted_line_count"], 0)
        self.assertEqual(payload["exclusions_by_reason"]["status_unknown"], 1)
        self.assertIn("outbound_excluded_status_unknown", warnings)

    @patch("inventory.services.outbound_performance._post_mes")
    def test_excludes_conflicts_non_sales_wrong_warehouse_cancelled_and_non_piece_units(self, post):
        rows = [
            _row(1, "A-JIT", _at(2026, 8, 10), plan=10, done=5),
            _row(2, "A-JIT-CKD", _at(2026, 8, 10)),
            _row(3, "A-UNCLASSIFIED", _at(2026, 8, 10)),
            _row(4, "A-JIT", _at(2026, 8, 10), bizType=2),
            _row(5, "A-JIT", _at(2026, 8, 10), wareHouse={"code": "Raw"}),
            _row(6, "A-JIT", _at(2026, 8, 10), bizStatus="withdrawn"),
            _row(7, "A-JIT", _at(2026, 8, 10), unit="kg"),
            _row(8, "A-JIT", _at(2026, 8, 10), plan="not-a-number"),
            _row(
                9,
                "A-JIT",
                _at(2026, 8, 10),
                unit="EA",
                plan={"amount": 10, "unit": {"name": "EA"}},
                done={"amount": 5, "unit": {"name": "kg"}},
            ),
            {
                "code": "A-JIT",
                "planTime": _at(2026, 8, 10),
                "planAmount": 10,
                "doneAmount": 5,
                "unit": "EA",
            },
        ]
        for row_id, missing_key in (
            (11, "bizType"),
            (12, "wareHouse"),
            (13, "bizStatus"),
        ):
            missing_header = _row(
                row_id,
                "A-JIT",
                _at(2026, 8, 10),
                plan=10,
                done=5,
            )
            missing_header.pop(missing_key)
            rows.append(missing_header)
        post.return_value = {"data": {"rows": rows, "count": len(rows)}}

        payload, warnings, source, _trace = get_outbound_performance(
            TARGET_DATE,
            force_refresh=True,
        )

        self.assertEqual(payload["status"], "partial")
        self.assertEqual(payload["accepted_line_count"], 1)
        self.assertEqual(payload["excluded_line_count"], 11)
        self.assertEqual(payload["unclassified"], {"order_count": 1, "line_count": 1})
        self.assertEqual(payload["periods"]["today"]["JIT"]["target_qty"], 10)
        self.assertEqual(payload["exclusions_by_reason"]["classification_conflict"], 1)
        self.assertEqual(payload["exclusions_by_reason"]["non_sales_business_type"], 1)
        self.assertEqual(payload["exclusions_by_reason"]["non_finished_goods_warehouse"], 1)
        self.assertEqual(payload["exclusions_by_reason"]["cancelled_or_deleted"], 1)
        self.assertEqual(payload["exclusions_by_reason"]["unit_not_piece"], 1)
        self.assertEqual(payload["exclusions_by_reason"]["unit_mixed_or_incompatible"], 1)
        self.assertEqual(payload["exclusions_by_reason"]["identity_missing"], 1)
        self.assertEqual(payload["exclusions_by_reason"]["business_type_missing"], 1)
        self.assertEqual(payload["exclusions_by_reason"]["warehouse_missing"], 1)
        self.assertEqual(payload["exclusions_by_reason"]["status_missing"], 1)
        self.assertTrue(any(item.startswith("outbound_excluded_") for item in warnings))
        self.assertEqual(source["status"], "partial")

    @patch("inventory.services.outbound_performance._post_mes")
    def test_deduplicates_by_order_and_line_when_line_id_is_absent(self, post):
        row = _row(1, "A-JIT", _at(2026, 8, 10), plan=50, done=25)
        row.pop("id")
        post.return_value = {"code": "200", "result": {"items": [row, dict(row)], "total": 2}}

        payload, warnings, _source, _trace = get_outbound_performance(
            TARGET_DATE,
            force_refresh=True,
        )

        self.assertEqual(payload["periods"]["today"]["JIT"]["target_qty"], 50)
        self.assertEqual(payload["deduplicated_line_count"], 1)
        self.assertIn("outbound_duplicate_lines_removed", warnings)
        self.assertIn("outbound_unique_lines_below_reported_total", warnings)
        self.assertEqual(payload["status"], "partial")

    @patch("inventory.services.outbound_performance._post_mes")
    def test_upstream_failure_is_unavailable_with_null_not_zero_metrics(self, post):
        post.side_effect = OutboundPerformanceError("permission denied")

        payload, warnings, source, trace = get_outbound_performance(
            TARGET_DATE,
            force_refresh=True,
        )

        self.assertEqual(payload["status"], "unavailable")
        metric = payload["periods"]["today"]["JIT"]
        self.assertIsNone(metric["target_qty"])
        self.assertIsNone(metric["fulfilled_qty"])
        self.assertIsNone(metric["order_count"])
        self.assertIsNone(
            payload["today_detail_summary"]["JIT"]["pending_line_count"]
        )
        self.assertIsNone(payload["today_detail_summary"]["JIT"]["remaining_qty"])
        self.assertEqual(payload["today_priority_items"], [])
        self.assertEqual(
            payload["unclassified"],
            {"order_count": None, "line_count": None},
        )
        self.assertEqual(warnings, ["outbound_performance_unavailable"])
        self.assertEqual(source["status"], "error")
        self.assertEqual(trace["status"], "error")

    @patch("inventory.services.outbound_performance._post_mes")
    def test_upstream_failure_is_negatively_cached_without_becoming_valid_zero(self, post):
        post.side_effect = OutboundPerformanceError("permission denied")

        first, _warnings, first_source, first_trace = get_outbound_performance(TARGET_DATE)
        second, _warnings, second_source, second_trace = get_outbound_performance(TARGET_DATE)

        self.assertEqual(post.call_count, 1)
        self.assertEqual(first["status"], "unavailable")
        self.assertEqual(first["cache_status"], "miss")
        self.assertEqual(first_source["status"], "error")
        self.assertEqual(first_trace["status"], "error")
        self.assertEqual(second["status"], "unavailable")
        self.assertEqual(second["cache_status"], "hit")
        self.assertIsNone(second["periods"]["today"]["JIT"]["target_qty"])
        self.assertIsNone(second["periods"]["today"]["JIT"]["fulfilled_qty"])
        self.assertEqual(second_source["status"], "error")
        self.assertEqual(second_source["detail"], "cached_upstream_unavailable")
        self.assertEqual(second_trace["status"], "error")
        self.assertEqual(second_trace["cache_status"], "hit")

    @patch("inventory.services.outbound_performance._post_mes")
    def test_success_is_cached_for_five_minute_read_path(self, post):
        post.return_value = {"data": {"list": [], "total": 0}}

        first, _warnings, _source, _trace = get_outbound_performance(TARGET_DATE)
        second, _warnings, _source, trace = get_outbound_performance(TARGET_DATE)

        self.assertEqual(post.call_count, 1)
        self.assertEqual(first["cache_status"], "miss")
        self.assertEqual(second["cache_status"], "hit")
        self.assertEqual(trace["cache_status"], "hit")
        self.assertEqual(second["periods"]["today"]["JIT"]["target_qty"], 0)
        self.assertEqual(
            second["today_detail_summary"]["JIT"]["pending_line_count"],
            0,
        )
        self.assertEqual(second["today_priority_items"], [])


class OverviewInventoryOutboundIntegrationTests(TestCase):
    @patch("production.overview_board.get_outbound_performance")
    def test_inventory_contract_keeps_legacy_stock_and_adds_outbound_metrics(self, outbound):
        outbound_payload = {
            "status": "ok",
            "fetched_at": "2026-08-10T12:00:00+08:00",
            "periods": {},
            "warnings": [],
        }
        outbound.return_value = (
            outbound_payload,
            [],
            {
                "status": "ok",
                "source_latest_at": outbound_payload["fetched_at"],
                "row_count": 3,
                "stale": False,
            },
            {
                "source": "BLACKLAKE inventory outbound_order._list items[]",
                "status": "ok",
                "rows_returned": 3,
            },
        )
        from production.overview_board import _build_inventory

        range_end = datetime(2026, 8, 11, 8, tzinfo=SHANGHAI_TZ)
        inventory, warnings, source, trace = _build_inventory(
            target_date=TARGET_DATE,
            range_end=range_end,
        )

        self.assertIs(inventory["outbound_performance"], outbound_payload)
        self.assertIn("finished_and_semifinished", inventory)
        self.assertIn("shipping", inventory)
        self.assertEqual(source["components"]["outbound_performance"], "ok")
        self.assertEqual(trace["components"][1]["rows_returned"], 3)
        self.assertIn("inventory_snapshot_missing", warnings)
