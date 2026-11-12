"""Pure calculation tests using synthetic figures; no Django/database setup."""

from decimal import Decimal, ROUND_HALF_UP
import unittest

from analytics.hr_labor_rules import (
    classify_day,
    contract_overtime,
    daily_default_overtime,
    default_labor_rules,
    employer_contribution,
    hourly_pay,
    month_day_counts,
)


D = Decimal


def money(value):
    return value.quantize(D("0.01"), rounding=ROUND_HALF_UP)


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
        result = hourly_pay("25", "8", "2", "8", "8")
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
        result = hourly_pay("1.005", regular_hours="1", weekday_overtime_hours="1")
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
    def test_known_department_candidates_stay_unconfirmed(self):
        for department, expected in (("注塑", "4"), ("加工", "2.5"), ("开发", "1")):
            with self.subTest(department=department):
                result = daily_default_overtime(department, "Synthetic role", "2026-11-13")
                self.assertEqual(result["status"], "unconfirmed")
                self.assertIsNone(result["hours"])
                self.assertEqual(result["candidate_hours"], D(expected))

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
                    self.assertEqual(result["status"], "missing")
                    self.assertIsNone(result["amount"])

    def test_gross_and_fixed_bases_are_separate_configured_rules(self):
        rules = default_labor_rules()
        rules["employer_contributions"]["social_insurance"]["contract"] = {
            "rate_percent": "8.25", "base": "gross", "fixed_amount": None,
        }
        rules["employer_contributions"]["housing_fund"]["hourly"] = {
            "rate_percent": "7.5", "base": "fixed", "fixed_amount": "2500",
        }
        social = employer_contribution("social_insurance", "contract", "3000.06", rules=rules,
                                       version=9, effective_month="2026-11")
        fund = employer_contribution("housing_fund", "hourly", "9999", rules=rules)
        self.assertEqual(social["status"], "ready")
        self.assertEqual(social["amount"], money(D("3000.06") * D("8.25") / D("100")))
        self.assertEqual(fund["status"], "ready")
        self.assertEqual(fund["amount"], D("187.50"))
        self.assertEqual(social["basis"]["standard_version"], 9)
        self.assertEqual(social["basis"]["effective_month"], "2026-11")
        self.assertEqual(social["basis"]["rate_percent"], D("8.25"))
        self.assertEqual(social["basis"]["base_amount"], D("3000.06"))
        rules["employer_contributions"]["social_insurance"]["contract"]["rate_percent"] = "10"
        self.assertEqual(employer_contribution("social_insurance", "contract", "3000.06", rules=rules)["amount"], D("300.01"))

    def test_missing_base_is_not_zero_but_explicit_zero_rate_is_valid(self):
        rules = default_labor_rules()
        config = rules["employer_contributions"]["social_insurance"]["contract"]
        config.update(rate_percent="0", base="gross")
        missing = employer_contribution("social_insurance", "contract", rules=rules)
        zero = employer_contribution("social_insurance", "contract", "3000", rules=rules)
        self.assertEqual(missing["status"], "missing")
        self.assertIsNone(missing["amount"])
        self.assertEqual(zero["status"], "ready")
        self.assertEqual(zero["amount"], D("0.00"))
        config.update(rate_percent="8", base="fixed", fixed_amount=None)
        self.assertIsNone(employer_contribution("social_insurance", "contract", "3000", rules=rules)["amount"])

    def test_contribution_uses_half_up_for_final_amount(self):
        rules = default_labor_rules()
        rules["employer_contributions"]["housing_fund"]["contract"] = {
            "rate_percent": "1", "base": "fixed", "fixed_amount": "100.5",
        }
        self.assertEqual(employer_contribution("housing_fund", "contract", rules=rules)["amount"], D("1.01"))

    def test_invalid_contribution_kind_and_numeric_inputs_are_rejected(self):
        for kind, employment_type in (("employee_deduction", "contract"), ("social_insurance", "unknown")):
            with self.subTest(kind=kind, employment_type=employment_type), self.assertRaises(ValueError):
                employer_contribution(kind, employment_type, "3000")
        for field in ("rate_percent", "gross_amount", "fixed_amount"):
            for invalid in ("-1", True, 1.5, "NaN", "Infinity"):
                with self.subTest(field=field, invalid=repr(invalid)):
                    rules = default_labor_rules()
                    config = rules["employer_contributions"]["social_insurance"]["contract"]
                    config.update(rate_percent="8", base="fixed" if field == "fixed_amount" else "gross", fixed_amount="3000")
                    gross = invalid if field == "gross_amount" else "3000"
                    if field != "gross_amount":
                        config[field] = invalid
                    with self.assertRaises(ValueError):
                        employer_contribution("social_insurance", "contract", gross, rules=rules)


class RuleIsolationTests(unittest.TestCase):
    def test_defaults_are_fresh_objects_and_do_not_retain_caller_changes(self):
        rules = default_labor_rules()
        rules["multipliers"]["workday"] = "9"
        rules["department_overtime"]["注塑"] = "99"
        rules["weekday_excluded_titles"]["titles"].append("Synthetic supervisor")
        fresh = default_labor_rules()
        self.assertEqual(fresh["multipliers"]["workday"], "1.5")
        self.assertEqual(fresh["department_overtime"]["注塑"], "4")
        self.assertEqual(fresh["weekday_excluded_titles"]["titles"], [])


if __name__ == "__main__":
    unittest.main()
