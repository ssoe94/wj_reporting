"""Pure calculation tests using synthetic figures; no Django/database setup."""

from decimal import Decimal, ROUND_HALF_UP, localcontext
import unittest

from analytics.hr_labor_rules import (
    classify_day,
    contribution_amounts,
    contract_overtime,
    daily_default_overtime,
    default_labor_rules,
    employer_contribution,
    employee_day,
    hourly_pay,
    month_day_counts,
    resolve_hourly_rate,
)


D = Decimal


def money(value):
    return value.quantize(D("0.01"), rounding=ROUND_HALF_UP)


def configured_contribution(rules, kind="social_insurance", employment_type="contract"):
    """Synthetic explicit zero rates distinguish entered zero from missing input."""
    config = rules["contributions"][kind]
    config["applies_to"][employment_type] = True
    config["base"]["rule"] = "gross"
    for rates in config["items"].values():
        rates.update(employer_rate="0", employee_rate="0")
    return config


class ContractOvertimeTests(unittest.TestCase):
    def test_synthetic_3000_salary_matches_three_day_categories(self):
        result = contract_overtime("3000", "2", "8", "8")
        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["weekday"], D("51.72"))
        self.assertEqual(result["rest_day"], D("275.86"))
        self.assertEqual(result["public_holiday"], D("413.79"))
        unit_rate = D("3000") / D("21.75") / D("8")
        self.assertEqual(result["total"], money(unit_rate * (D("2") * D("1.5") + D("8") * D("2") + D("8") * D("3"))))
        self.assertEqual(result["total"], D("741.38"))

    def test_unit_rate_is_not_rounded_before_calculating_pay(self):
        result = contract_overtime("3000", weekday_hours="8")
        self.assertEqual(result["weekday"], D("206.90"))
        self.assertNotEqual(result["weekday"], money(D("17.24") * D("8") * D("1.5")))

    def test_weekday_exemption_keeps_rest_and_holiday_pay(self):
        result = contract_overtime("3000", "2", "8", "8", weekday_exempt=True)
        self.assertEqual(result["weekday"], D("0.00"))
        self.assertEqual(result["rest_day"], D("275.86"))
        self.assertEqual(result["public_holiday"], D("413.79"))
        self.assertEqual(result["total"], money(D("3000") / D("21.75") / D("8") * D("40")))

    def test_basis_preserves_rule_version_month_hours_and_multipliers(self):
        result = contract_overtime(D("3000"), 2, "8", D("8"), version=7, effective_month="2026-11")
        basis = result["basis"]
        self.assertEqual(basis["standard_version"], 7)
        self.assertEqual(basis["effective_month"], "2026-11")
        self.assertLess(abs(basis["unit_rate"] - D("3000") / D("21.75") / D("8")), D("1e-26"))
        self.assertEqual(basis["hours"], {"workday": D("2"), "rest_day": D("8"), "public_holiday": D("8")})
        self.assertEqual(basis["multipliers"], {"workday": D("1.5"), "rest_day": D("2"), "public_holiday": D("3")})

    def test_zero_inputs_are_valid(self):
        result = contract_overtime(0)
        self.assertEqual(result["status"], "ready")
        for field in ("weekday", "rest_day", "public_holiday", "total"):
            self.assertEqual(result[field], D("0.00"))

    def test_custom_divisors_and_multipliers_change_the_result(self):
        rules = default_labor_rules()
        rules["contract"] = {"days_per_month": "20", "hours_per_day": "8"}
        rules["multipliers"] = {"workday": "1.25", "rest_day": "1.75", "public_holiday": "2.5"}
        result = contract_overtime("3200", "2", "2", "2", rules=rules)
        self.assertEqual(result["basis"]["unit_rate"], D("20"))
        self.assertEqual((result["weekday"], result["rest_day"], result["public_holiday"], result["total"]),
                         (D("50.00"), D("70.00"), D("100.00"), D("220.00")))

    def test_zero_divisors_are_rejected(self):
        for field in ("days_per_month", "hours_per_day"):
            with self.subTest(field=field):
                rules = default_labor_rules()
                rules["contract"][field] = "0"
                with self.assertRaises(ValueError):
                    contract_overtime("3000", rules=rules)

    def test_rejects_unsafe_numeric_inputs_in_every_amount_argument(self):
        invalid = (-1, "-0.01", True, False, 1.5, float("nan"), "NaN", D("NaN"), "Infinity", D("-Infinity"), None, "")
        arguments = ("base_salary", "weekday_hours", "rest_hours", "holiday_hours")
        for argument in arguments:
            for value in invalid:
                with self.subTest(argument=argument, value=repr(value)):
                    values = {"base_salary": "3000", argument: value}
                    with self.assertRaises(ValueError):
                        contract_overtime(**values)


class HourlyPayTests(unittest.TestCase):
    def test_unconfirmed_hourly_premium_never_claims_ready(self):
        rules = default_labor_rules()
        rules["hourly_premium"] = {"enabled": False, "confirmed": False}
        result = hourly_pay("25", "8", "2", "8", "8", rules=rules)
        self.assertEqual(result["status"], "unconfirmed")
        self.assertEqual(result["total"], D("650.00"))
        self.assertEqual(set(result["basis"]["multipliers"].values()), {D("1")})

    def test_confirmed_disabled_premium_uses_regular_unit_rate_for_all_hours(self):
        rules = default_labor_rules()
        rules["hourly_premium"] = {"enabled": False, "confirmed": True}
        result = hourly_pay("25", "8", "2", "8", "8", rules=rules, version=3, effective_month="2026-11")
        self.assertEqual(result["status"], "ready")
        self.assertEqual((result["regular"], result["weekday"], result["rest_day"], result["public_holiday"]),
                         (D("200.00"), D("50.00"), D("200.00"), D("200.00")))
        self.assertEqual(result["basis"]["standard_version"], 3)
        self.assertEqual(result["basis"]["effective_month"], "2026-11")

    def test_confirmed_enabled_premium_applies_each_configured_multiplier(self):
        rules = default_labor_rules()
        rules["hourly_premium"] = {"enabled": True, "confirmed": True}
        result = hourly_pay("25", "8", "2", "8", "8", rules=rules)
        self.assertEqual(result["status"], "ready")
        self.assertEqual((result["regular"], result["weekday"], result["rest_day"], result["public_holiday"], result["total"]),
                         (D("200.00"), D("75.00"), D("400.00"), D("600.00"), D("1275.00")))
        self.assertEqual(result["basis"]["multipliers"],
                         {"regular": D("1"), "workday": D("1.5"), "rest_day": D("2"), "public_holiday": D("3")})
        rules["multipliers"]["rest_day"] = "2.25"
        self.assertEqual(hourly_pay("25", rest_hours="8", rules=rules)["rest_day"], D("450.00"))

    def test_half_up_rounds_components_and_total_from_unrounded_amounts(self):
        rules = default_labor_rules()
        rules["hourly_premium"]["enabled"] = False
        result = hourly_pay("1.005", regular_hours="1", weekday_overtime_hours="1", rules=rules)
        self.assertEqual(result["regular"], D("1.01"))
        self.assertEqual(result["weekday"], D("1.01"))
        self.assertEqual(result["total"], D("2.01"))

    def test_rejects_unsafe_numeric_inputs_in_every_amount_argument(self):
        invalid = (-1, "-0.01", True, 1.5, "NaN", "Infinity", None)
        arguments = ("unit_rate", "regular_hours", "weekday_overtime_hours", "rest_hours", "holiday_hours")
        for argument in arguments:
            for value in invalid:
                with self.subTest(argument=argument, value=repr(value)):
                    values = {"unit_rate": "25", argument: value}
                    with self.assertRaises(ValueError):
                        hourly_pay(**values)


class CalendarRuleTests(unittest.TestCase):
    def test_default_calendar_uses_only_weekdays_and_weekends(self):
        for day, expected in (("2026-11-13", "workday"), ("2026-11-14", "rest_day"), ("2026-11-15", "rest_day")):
            with self.subTest(day=day):
                result = classify_day(day)
                self.assertEqual(result["type"], expected)
                self.assertEqual(result["status"], "ready")
        # A calendar date that may be a holiday must not be guessed from its name.
        self.assertEqual(classify_day("2026-01-01")["type"], "workday")

    def test_explicit_calendar_overrides_weekend_and_weekday_defaults(self):
        overrides = {"2026-11-14": "adjusted_workday", "2026-11-16": "public_holiday"}
        adjusted = classify_day("2026-11-14", overrides)
        holiday = classify_day("2026-11-16", overrides)
        self.assertEqual(adjusted["type"], "adjusted_workday")
        self.assertEqual(adjusted["basis"]["applied_multiplier"], D("1.5"))
        self.assertEqual(holiday["type"], "public_holiday")
        self.assertEqual(holiday["basis"]["applied_multiplier"], D("3"))

    def test_month_counts_include_adjusted_workday_in_workdays(self):
        overrides = {"2026-11-14": "adjusted_workday", "2026-11-16": "public_holiday"}
        result = month_day_counts("2026-11", overrides)
        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["workdays"], 21)
        self.assertEqual(result["rest_days"], 8)
        self.assertEqual(result["public_holidays"], 1)
        self.assertEqual(result["adjusted_workdays"], 1)
        self.assertEqual(result["workdays"] + result["rest_days"] + result["public_holidays"], 30)

    def test_month_counts_cover_leap_year(self):
        result = month_day_counts("2024-02")
        self.assertEqual(result["workdays"], 21)
        self.assertEqual(result["rest_days"], 8)
        self.assertEqual(result["public_holidays"], 0)
        self.assertEqual(result["adjusted_workdays"], 0)

    def test_calendar_basis_carries_independent_standard_and_calendar_versions(self):
        for function, value in ((classify_day, "2026-11-14"), (month_day_counts, "2026-11")):
            with self.subTest(function=function.__name__):
                result = function(value, version=7, effective_month="2026-10", calendar_version=4)
                self.assertEqual(result["basis"]["standard_version"], 7)
                self.assertEqual(result["basis"]["effective_month"], "2026-10")
                self.assertEqual(result["basis"]["calendar_version"], 4)

    def test_invalid_calendar_inputs_do_not_silently_fall_back(self):
        for day in ("2026-02-30", "2026-11", "2026-1-1", None):
            with self.subTest(day=day), self.assertRaises(ValueError):
                classify_day(day)
        for month in ("2026-00", "2026-13", "2026-1", None):
            with self.subTest(month=month), self.assertRaises(ValueError):
                month_day_counts(month)
        with self.assertRaises(ValueError):
            classify_day("2026-11-14", {"2026-11-14": "unknown"})


class DailyDefaultOvertimeTests(unittest.TestCase):
    def test_confirmed_department_defaults_are_actual_overtime_only(self):
        for department, expected in (("注塑", "4"), ("加工", "2.5"), ("开发", "1")):
            with self.subTest(department=department):
                result = daily_default_overtime(department, "Synthetic role", "2026-11-13")
                self.assertEqual(result["status"], "ready")
                self.assertEqual(result["hours"], D(expected))
                self.assertEqual(result["candidate_hours"], D(expected))
                self.assertIs(result["basis"]["include_fixed_overtime"], False)

    def test_unentered_and_unknown_departments_stay_missing(self):
        for department in ("管理部", "总经办", "Synthetic unknown department"):
            with self.subTest(department=department):
                result = daily_default_overtime(department, "Synthetic role", "2026-11-13")
                self.assertEqual(result["status"], "missing")
                self.assertIsNone(result["hours"])
                self.assertIsNone(result["candidate_hours"])

    def test_each_unconfirmed_decision_prevents_ready_default_hours(self):
        for title_confirmed, includes_fixed in ((False, True), (False, False), (True, None)):
            with self.subTest(title_confirmed=title_confirmed, includes_fixed=includes_fixed):
                rules = default_labor_rules()
                rules["weekday_excluded_titles"]["confirmed"] = title_confirmed
                rules["department_hours_include_fixed_overtime"] = includes_fixed
                result = daily_default_overtime("注塑", "Synthetic role", "2026-11-13", rules=rules)
                self.assertEqual(result["status"], "unconfirmed")
                self.assertIsNone(result["hours"])
                self.assertEqual(result["candidate_hours"], D("4"))

    def test_confirmed_default_and_updated_department_hours_are_used(self):
        rules = default_labor_rules()
        rules["weekday_excluded_titles"]["confirmed"] = True
        rules["department_hours_include_fixed_overtime"] = False
        rules["department_overtime"]["注塑"] = "3.25"
        result = daily_default_overtime("注塑", "Synthetic role", "2026-11-13", rules=rules,
                                        version=8, effective_month="2026-11", calendar_version=2)
        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["hours"], D("3.25"))
        self.assertEqual(result["basis"]["standard_version"], 8)
        self.assertEqual(result["basis"]["effective_month"], "2026-11")
        self.assertEqual(result["basis"]["calendar_version"], 2)

    def test_confirmed_excluded_title_has_zero_weekday_hours_even_if_fixed_rule_unknown(self):
        rules = default_labor_rules()
        rules["weekday_excluded_titles"] = {"titles": ["Synthetic supervisor"], "confirmed": True}
        rules["department_hours_include_fixed_overtime"] = None
        result = daily_default_overtime("注塑", "Synthetic supervisor", "2026-11-13", rules=rules)
        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["hours"], D("0"))

    def test_weekend_and_holiday_require_manual_hours_for_excluded_titles(self):
        rules = default_labor_rules()
        rules["weekday_excluded_titles"] = {"titles": ["Synthetic supervisor"], "confirmed": True}
        overrides = {"2026-11-16": "public_holiday"}
        for day in ("2026-11-14", "2026-11-16"):
            with self.subTest(day=day):
                result = daily_default_overtime("注塑", "Synthetic supervisor", day, rules=rules, overrides=overrides)
                self.assertEqual(result["status"], "manual_required")
                self.assertIsNone(result["hours"])
                self.assertIsNone(result["candidate_hours"])

    def test_adjusted_saturday_uses_weekday_department_default(self):
        rules = default_labor_rules()
        rules["weekday_excluded_titles"]["confirmed"] = True
        rules["department_hours_include_fixed_overtime"] = True
        result = daily_default_overtime("加工", "Synthetic role", "2026-11-14", rules=rules,
                                        overrides={"2026-11-14": "adjusted_workday"})
        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["hours"], D("2.5"))


class EmployerContributionTests(unittest.TestCase):
    def test_unentered_rates_remain_missing_in_both_employment_types(self):
        for kind in ("social_insurance", "housing_fund"):
            for employment_type in ("contract", "hourly"):
                with self.subTest(kind=kind, employment_type=employment_type):
                    result = employer_contribution(kind, employment_type, "3000")
                    self.assertEqual(result["status"], "partial_missing")
                    self.assertIsNone(result["amount"])

    def test_gross_and_common_bases_are_separate_configured_rules(self):
        rules = default_labor_rules()
        social_config = configured_contribution(rules)
        social_config["items"]["pension"]["employer_rate"] = "8.25"
        fund_config = configured_contribution(rules, "housing_fund", "hourly")
        fund_config["items"]["housing_fund"]["employer_rate"] = "7.5"
        fund_config["base"].update(rule="common", common_amount="2500")
        social = employer_contribution("social_insurance", "contract", "3000.06", rules=rules,
                                       version=9, effective_month="2026-11")
        fund = employer_contribution("housing_fund", "hourly", "9999", rules=rules)
        self.assertEqual(social["status"], "ready")
        self.assertEqual(social["amount"], money(D("3000.06") * D("8.25") / D("100")))
        self.assertEqual(fund["status"], "ready")
        self.assertEqual(fund["amount"], D("187.50"))
        self.assertEqual(social["basis"]["standard_version"], 9)
        self.assertEqual(social["basis"]["effective_month"], "2026-11")
        self.assertEqual(social["items"]["pension"]["basis"]["rates"]["employer_rate"], D("8.25"))
        self.assertEqual(social["basis"]["base_amount"], D("3000.06"))
        social_config["items"]["pension"]["employer_rate"] = "10"
        self.assertEqual(employer_contribution("social_insurance", "contract", "3000.06", rules=rules)["amount"], D("300.01"))

    def test_missing_base_is_not_zero_but_explicit_zero_rate_is_valid(self):
        rules = default_labor_rules()
        config = configured_contribution(rules)
        missing = employer_contribution("social_insurance", "contract", rules=rules)
        zero = employer_contribution("social_insurance", "contract", "3000", rules=rules)
        self.assertEqual(missing["status"], "partial_missing")
        self.assertIsNone(missing["amount"])
        self.assertEqual(zero["status"], "ready")
        self.assertEqual(zero["amount"], D("0.00"))
        config["items"]["pension"]["employer_rate"] = "8"
        config["base"].update(rule="common", common_amount=None)
        self.assertIsNone(employer_contribution("social_insurance", "contract", "3000", rules=rules)["amount"])

    def test_contribution_uses_half_up_for_final_amount(self):
        rules = default_labor_rules()
        config = configured_contribution(rules, "housing_fund")
        config["items"]["housing_fund"]["employer_rate"] = "1"
        config["base"].update(rule="common", common_amount="100.5")
        self.assertEqual(employer_contribution("housing_fund", "contract", rules=rules)["amount"], D("1.01"))

    def test_invalid_contribution_kind_and_numeric_inputs_are_rejected(self):
        for kind, employment_type in (("employee_deduction", "contract"), ("social_insurance", "unknown")):
            with self.subTest(kind=kind, employment_type=employment_type), self.assertRaises(ValueError):
                employer_contribution(kind, employment_type, "3000")
        for field in ("employer_rate", "employee_rate", "gross_amount", "common_amount"):
            for invalid in ("-1", True, 1.5, "NaN", "Infinity"):
                with self.subTest(field=field, invalid=repr(invalid)):
                    rules = default_labor_rules()
                    config = configured_contribution(rules)
                    gross = invalid if field == "gross_amount" else "3000"
                    if field == "common_amount":
                        config["base"].update(rule="common", common_amount=invalid)
                    elif field != "gross_amount":
                        config["items"]["pension"][field] = invalid
                    with self.assertRaises(ValueError):
                        employer_contribution("social_insurance", "contract", gross, rules=rules)


class ItemizedContributionTests(unittest.TestCase):
    def test_common_base_clamps_before_computing_each_side(self):
        for raw, applied in (("2000", "3000"), ("4000", "4000"), ("6000", "5000")):
            with self.subTest(raw=raw):
                rules = default_labor_rules()
                config = configured_contribution(rules)
                config["base"].update(rule="common", common_amount=raw, lower="3000", upper="5000")
                config["items"]["pension"].update(employer_rate="10", employee_rate="5")
                result = contribution_amounts("social_insurance", "contract", "9999", rules=rules,
                                              version=9, effective_month="2026-11")
                self.assertEqual(result["status"], "ready")
                self.assertEqual(result["totals"], {"employer": money(D(applied) / 10), "employee": money(D(applied) / 20)})
                basis = result["items"]["pension"]["basis"]
                self.assertEqual(basis["raw_base"], D(raw))
                self.assertEqual(basis["base_amount"], D(applied))
                self.assertEqual((basis["lower"], basis["upper"]), (D("3000"), D("5000")))
                self.assertEqual((basis["standard_version"], basis["effective_month"]), (9, "2026-11"))

    def test_employee_base_never_falls_back_to_gross_or_company_amount(self):
        rules = default_labor_rules()
        config = configured_contribution(rules, "housing_fund")
        config["base"].update(rule="employee", common_amount="6000", employee_amounts={"101": "3200"})
        config["items"]["housing_fund"].update(employer_rate="8", employee_rate="6")
        known = contribution_amounts("housing_fund", "contract", "9000", employee_id=101, rules=rules)
        missing = contribution_amounts("housing_fund", "contract", "9000", employee_id=102, rules=rules)
        self.assertEqual(known["totals"], {"employer": D("256.00"), "employee": D("192.00")})
        self.assertEqual(missing["status"], "partial_missing")
        self.assertEqual(missing["totals"], {"employer": None, "employee": None})
        self.assertIsNone(missing["basis"]["base_amount"])

    def test_one_missing_side_marks_whole_item_missing_and_preserves_known_subtotals(self):
        for missing_side in ("employer_rate", "employee_rate"):
            with self.subTest(missing_side=missing_side):
                rules = default_labor_rules()
                config = configured_contribution(rules)
                config["items"]["pension"].update(employer_rate="8", employee_rate="4")
                config["items"]["medical"].update(employer_rate="5", employee_rate="2")
                config["items"]["medical"][missing_side] = None
                result = contribution_amounts("social_insurance", "contract", "3000", rules=rules)
                self.assertEqual(result["status"], "partial_missing")
                self.assertEqual(result["totals"], {"employer": None, "employee": None})
                self.assertEqual(result["known_totals"], {"employer": D("240.00"), "employee": D("120.00")})
                self.assertEqual(result["items"]["medical"]["status"], "missing")
                self.assertIsNone(result["items"]["medical"]["employer"])
                self.assertIsNone(result["items"]["medical"]["employee"])
                self.assertEqual(result["items"]["maternity"]["status"], "ready")
                self.assertEqual(result["items"]["maternity"]["employer"], D("0.00"))

    def test_rounds_each_item_half_up_before_sum(self):
        rules = default_labor_rules()
        config = configured_contribution(rules)
        for rates in config["items"].values():
            rates.update(employer_rate="1", employee_rate="0.5")
        result = contribution_amounts("social_insurance", "contract", "0.50", rules=rules)
        self.assertTrue(all(item["employer"] == D("0.01") for item in result["items"].values()))
        self.assertEqual(result["totals"], {"employer": D("0.05"), "employee": D("0.00")})
        self.assertNotEqual(result["totals"]["employer"], money(D("0.50") * D("0.01") * 5))

    def test_non_applicability_is_explicit_and_scoped_to_employment_type(self):
        rules = default_labor_rules()
        rules["contributions"]["social_insurance"]["applies_to"]["hourly"] = False
        hourly = contribution_amounts("social_insurance", "hourly", rules=rules)
        contract = contribution_amounts("social_insurance", "contract", rules=rules)
        self.assertEqual(hourly["status"], "not_applicable")
        self.assertEqual(hourly["totals"], {"employer": D("0.00"), "employee": D("0.00")})
        self.assertTrue(all(item["status"] == "not_applicable" for item in hourly["items"].values()))
        self.assertEqual(contract["status"], "partial_missing")
        self.assertIsNone(contract["totals"]["employer"])

    def test_invalid_bounds_and_percentage_are_rejected(self):
        rules = default_labor_rules()
        config = configured_contribution(rules)
        config["base"].update(lower="5000", upper="3000")
        with self.assertRaises(ValueError):
            contribution_amounts("social_insurance", "contract", "4000", rules=rules)
        config["base"].update(lower=None, upper=None)
        config["items"]["pension"]["employer_rate"] = "100.01"
        with self.assertRaises(ValueError):
            contribution_amounts("social_insurance", "contract", "4000", rules=rules)


class HourlyRateResolutionTests(unittest.TestCase):
    def test_latest_effective_employee_exception_precedes_company_default(self):
        rules = default_labor_rules()
        rules["hourly_rates"]["company_default"] = {"amount": "25", "confirmed": True}
        rules["hourly_rates"]["employee_overrides"] = [
            {"employee_id": 101, "effective_month": "2026-11", "amount": "32", "reason": "Synthetic November exception"},
            {"employee_id": 102, "effective_month": "2026-01", "amount": "99", "reason": "Synthetic other employee"},
            {"employee_id": 101, "effective_month": "2026-08", "amount": "30", "reason": "Synthetic August exception"},
        ]
        for month, expected, source in (("2026-07", "25", "company_default"),
                                        ("2026-08", "30", "employee_override"),
                                        ("2026-10", "30", "employee_override"),
                                        ("2026-11", "32", "employee_override")):
            with self.subTest(month=month):
                result = resolve_hourly_rate(101, month, rules=rules, version=5, effective_month="2026-06")
                self.assertEqual(result["status"], "ready")
                self.assertEqual(result["amount"], D(expected))
                self.assertEqual(result["basis"]["source"], source)
                self.assertEqual(result["basis"]["standard_version"], 5)
        latest = resolve_hourly_rate(101, "2026-12", rules=rules)
        self.assertEqual(latest["basis"]["rate_effective_month"], "2026-11")
        self.assertEqual(latest["basis"]["reason"], "Synthetic November exception")
        self.assertEqual(resolve_hourly_rate(103, "2026-11", rules=rules)["amount"], D("25"))

    def test_company_rate_missing_and_unconfirmed_are_distinct(self):
        result = resolve_hourly_rate(101, "2026-11")
        self.assertEqual(result["status"], "unconfirmed")
        self.assertEqual(result["amount"], D("24.50"))
        rules = default_labor_rules()
        rules["hourly_rates"]["company_default"]["amount"] = None
        missing = resolve_hourly_rate(101, "2026-11", rules=rules)
        self.assertEqual(missing["status"], "missing")
        self.assertIsNone(missing["amount"])


class EmployeeDayTests(unittest.TestCase):
    def setUp(self):
        self.rules = default_labor_rules()
        self.rules["hourly_rates"]["company_default"]["confirmed"] = True
        self.employee = {"id": 101, "employment_type": "contract", "title": "Synthetic worker", "department": "注塑"}
        self.payroll = {"month": "2026-10", "base_salary": "3000", "fixed_overtime": "125.50", "gross_amount": "4000"}

    def test_contract_monthly_references_are_separate_from_daily_actual_overtime(self):
        result = employee_day(self.employee, "2026-11-13", payroll=self.payroll, rules=self.rules,
                              version=5, effective_month="2026-11", calendar_version=2)
        self.assertEqual((result["salary"]["period"], result["salary"]["amount"]), ("month", D("3000.00")))
        fixed = result["overtime"]["fixed"]
        self.assertEqual((fixed["period"], fixed["amount"], fixed["source_month"], fixed["carried_forward"]),
                         ("month", D("125.50"), "2026-10", True))
        weekday = result["overtime"]["weekday"]
        self.assertEqual((weekday["period"], weekday["amount"]), ("day", D("103.45")))
        self.assertTrue(all(value["period"] == "month" for value in result["contributions"].values()))
        daily = [result["salary"], *result["overtime"].values()]
        self.assertEqual(sum(item["amount"] for item in daily if item["period"] == "day"), D("103.45"))
        self.assertEqual(result["basis"]["standard_version"], 5)
        self.assertEqual(result["basis"]["calendar_version"], 2)
        self.assertEqual(result["basis"]["payroll_source_month"], "2026-10")

    def test_all_four_excluded_titles_keep_fixed_rest_and_holiday_pay_in_every_department(self):
        overrides = {"2026-11-16": "public_holiday"}
        for title in ("Part長", "部长", "财务部长兼办公室主任", "技术生产总经理"):
            for department in ("注塑", "管理部", "总经办"):
                with self.subTest(title=title, department=department):
                    employee = self.employee | {"title": title, "department": department}
                    weekday = employee_day(employee, "2026-11-13", payroll=self.payroll, overtime_hours="8", rules=self.rules)
                    rest = employee_day(employee, "2026-11-14", payroll=self.payroll, overtime_hours="8", rules=self.rules)
                    holiday = employee_day(employee, "2026-11-16", payroll=self.payroll, overtime_hours="8", rules=self.rules, overrides=overrides)
                    self.assertEqual(weekday["overtime"]["weekday"]["amount"], D("0.00"))
                    self.assertEqual(rest["overtime"]["rest_day"]["amount"], D("275.86"))
                    self.assertEqual(holiday["overtime"]["public_holiday"]["amount"], D("413.79"))
                    self.assertEqual(weekday["overtime"]["fixed"]["amount"], D("125.50"))

    def test_engineer_is_included_until_explicitly_added_to_excluded_titles(self):
        employee = self.employee | {"title": "工程师"}
        included = employee_day(employee, "2026-11-13", payroll=self.payroll, rules=self.rules)
        self.assertEqual(included["overtime"]["weekday"]["amount"], D("103.45"))
        self.rules["weekday_excluded_titles"]["titles"].append("工程师")
        excluded = employee_day(employee, "2026-11-13", payroll=self.payroll, rules=self.rules)
        self.assertEqual(excluded["overtime"]["weekday"]["amount"], D("0.00"))

    def test_admin_worker_hours_stay_missing_until_supplied(self):
        employee = self.employee | {"department": "管理部"}
        missing = employee_day(employee, "2026-11-13", payroll=self.payroll, rules=self.rules)
        self.assertEqual(missing["overtime"]["weekday"]["status"], "missing")
        self.assertIsNone(missing["overtime"]["weekday"]["amount"])
        explicit = employee_day(employee, "2026-11-13", payroll=self.payroll, rules=self.rules, overtime_hours="2")
        self.assertEqual(explicit["overtime"]["weekday"]["amount"], D("51.72"))

    def test_current_month_and_missing_payroll_components_are_not_invented(self):
        current = employee_day(self.employee, "2026-11-13", payroll=self.payroll | {"month": "2026-11"}, rules=self.rules)
        self.assertFalse(current["overtime"]["fixed"]["carried_forward"])
        missing = employee_day(self.employee, "2026-11-13", payroll={"month": "2026-11", "gross_amount": "4000"}, rules=self.rules)
        for component in (missing["salary"], missing["overtime"]["fixed"], missing["overtime"]["weekday"]):
            self.assertEqual(component["status"], "missing")
            self.assertIsNone(component["amount"])
        self.assertIsNone(missing["contributions"]["social_insurance"]["totals"]["employer"])
        with self.assertRaises(ValueError):
            employee_day(self.employee, "2026-11-13", payroll=self.payroll | {"month": "2026-12"}, rules=self.rules)

    def test_hourly_regular_and_actual_overtime_use_exception_before_company_rate(self):
        employee = self.employee | {"employment_type": "hourly"}
        company = employee_day(employee, "2026-11-13", rules=self.rules)
        self.assertEqual((company["salary"]["period"], company["salary"]["amount"]), ("day", D("196.00")))
        self.assertEqual(company["overtime"]["weekday"]["amount"], D("147.00"))
        self.rules["hourly_rates"]["employee_overrides"] = [
            {"employee_id": 101, "effective_month": "2026-11", "amount": "32", "reason": "Synthetic exception"},
        ]
        override = employee_day(employee, "2026-11-13", rules=self.rules)
        self.assertEqual(override["salary"]["amount"], D("256.00"))
        self.assertEqual(override["overtime"]["weekday"]["amount"], D("192.00"))
        self.assertEqual(override["basis"]["hourly_rate"]["source"], "employee_override")

    def test_hourly_rest_and_holiday_hours_are_manual_and_do_not_add_regular_pay(self):
        employee = self.employee | {"employment_type": "hourly"}
        overrides = {"2026-11-16": "public_holiday"}
        for day, slot, amount in (("2026-11-14", "rest_day", "392.00"), ("2026-11-16", "public_holiday", "588.00")):
            with self.subTest(day=day):
                manual = employee_day(employee, day, rules=self.rules, overrides=overrides)
                self.assertEqual(manual["overtime"][slot]["status"], "manual_required")
                self.assertIsNone(manual["overtime"][slot]["amount"])
                entered = employee_day(employee, day, overtime_hours="8", rules=self.rules, overrides=overrides)
                self.assertEqual(entered["salary"]["amount"], D("0.00"))
                self.assertEqual(entered["overtime"][slot]["amount"], D(amount))
                with self.assertRaises(ValueError):
                    employee_day(employee, day, regular_hours="8", rules=self.rules, overrides=overrides)

    def test_adjusted_saturday_uses_regular_hours_and_weekday_premium(self):
        employee = self.employee | {"employment_type": "hourly"}
        result = employee_day(employee, "2026-11-14", rules=self.rules, overrides={"2026-11-14": "adjusted_workday"})
        self.assertEqual(result["salary"]["amount"], D("196.00"))
        self.assertEqual(result["overtime"]["weekday"]["amount"], D("147.00"))
        self.assertEqual(result["overtime"]["rest_day"]["amount"], D("0.00"))

    def test_hourly_missing_rate_and_unconfirmed_rate_cannot_claim_ready(self):
        employee = self.employee | {"employment_type": "hourly"}
        self.rules["hourly_rates"]["company_default"]["confirmed"] = False
        unconfirmed = employee_day(employee, "2026-11-13", rules=self.rules)
        self.assertEqual(unconfirmed["salary"]["status"], "unconfirmed")
        self.assertEqual(unconfirmed["overtime"]["weekday"]["status"], "unconfirmed")
        self.rules["hourly_rates"]["company_default"]["amount"] = None
        missing = employee_day(employee, "2026-11-13", rules=self.rules)
        self.assertEqual(missing["salary"]["status"], "missing")
        self.assertIsNone(missing["salary"]["amount"])
        self.assertIsNone(missing["overtime"]["weekday"]["amount"])

    def test_monthly_components_do_not_depend_on_callers_decimal_precision(self):
        payroll = self.payroll | {"base_salary": "123456.78", "fixed_overtime": "123456.78"}
        with localcontext() as context:
            context.prec = 6
            result = employee_day(self.employee, "2026-11-13", payroll=payroll, rules=self.rules)
        self.assertEqual(result["salary"]["amount"], D("123456.78"))
        self.assertEqual(result["overtime"]["fixed"]["amount"], D("123456.78"))


class RuleIsolationTests(unittest.TestCase):
    def test_defaults_are_fresh_objects_and_do_not_retain_caller_changes(self):
        rules = default_labor_rules()
        rules["multipliers"]["workday"] = "9"
        rules["department_overtime"]["注塑"] = "99"
        rules["weekday_excluded_titles"]["titles"].append("Synthetic supervisor")
        fresh = default_labor_rules()
        self.assertEqual(fresh["multipliers"]["workday"], "1.5")
        self.assertEqual(fresh["department_overtime"]["注塑"], "4")
        self.assertEqual(fresh["weekday_excluded_titles"]["titles"], ["Part長", "部长", "财务部长兼办公室主任", "技术生产总经理"])


if __name__ == "__main__":
    unittest.main()
