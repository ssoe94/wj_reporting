from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from typing import Any, Dict, Iterable, List, Mapping, Optional

import pandas as pd
from django.utils import timezone


class ProductionPlanProcessingError(Exception):
    """Raised when the production plan workbook cannot be parsed."""


@dataclass(frozen=True)
class PlanSchema:
    rename_map: Mapping[str, str]


SCHEMAS: Mapping[str, PlanSchema] = {
    "injection": PlanSchema(
        rename_map={
            "設  備  ": "machine",
            "LOT NO": "lot_no",
            "MODEL ": "model",
            "SPEC": "part_spec",
            "成品 P/N": "fg_part_no",
            "半成品 P/N": "sg_part_no",
            "原料": "material",
            "COLOR": "color",
            "IN": "delivery_date",
            "LOT": "lot_qty",
            "END": "produced_qty",
            "余  量": "req_qty",
        }
    ),
    "machining": PlanSchema(
        rename_map={
            "設  備  ": "machine",
            "LOT NO": "lot_no",
            "MODEL ": "model",
            "SUFFIX": "part_spec",
            "SPEC": "spec_detail",
            "PART NO": "fg_part_no",
            "半成品 P/N": "sg_part_no",
            "原料": "material",
            "IN": "delivery_date",
            "LOT": "lot_qty",
            "余  量": "req_qty",
        }
    ),
}


class ProductionPlanProcessor:
    """Convert uploaded Excel workbooks into normalized JSON payloads."""

    def __init__(self, uploaded_file, plan_type: str, target_date: Optional[str]) -> None:
        if plan_type not in SCHEMAS:
            raise ProductionPlanProcessingError("지원하지 않는 계획 유형입니다.")
        self.schema = SCHEMAS[plan_type]
        self.plan_type = plan_type
        self.uploaded_file = uploaded_file
        self.target_date = self._parse_date(target_date)

    def _parse_date(self, value: Optional[str]) -> date:
        if not value:
            return timezone.localdate()
        if isinstance(value, date):
            return value
        if isinstance(value, datetime):
            return value.date()
        try:
            return datetime.strptime(value, "%Y-%m-%d").date()
        except (TypeError, ValueError) as exc:
            raise ProductionPlanProcessingError("target_date는 YYYY-MM-DD 형식이어야 합니다.") from exc

    def process(self) -> Dict[str, Any]:
        self.uploaded_file.seek(0)
        try:
            workbook = pd.ExcelFile(self.uploaded_file)
        except Exception as exc:
            raise ProductionPlanProcessingError("엑셀 파일을 열 수 없습니다.") from exc

        sheet_name = self._resolve_sheet_name(workbook.sheet_names)
        try:
            df = pd.read_excel(workbook, sheet_name=sheet_name, header=2)
            # Add original_order column to preserve sequence
            df.reset_index(inplace=True)
            df.rename(columns={'index': 'original_order'}, inplace=True)
        except Exception as exc:
            raise ProductionPlanProcessingError("시트를 읽는 중 오류가 발생했습니다.") from exc

        df = df.rename(columns=self.schema.rename_map)
        df = df[df.get("lot_no").notna() & df.get("lot_no").astype(str).str.strip().ne("")].copy()
        df = self._filter_machine_rows(df)
        if df.empty:
            raise ProductionPlanProcessingError("유효한 계획 행을 찾을 수 없습니다.")

        day_columns = self._extract_day_columns(df.columns)
        if not day_columns:
            raise ProductionPlanProcessingError("생산 계획 수량이 포함된 날짜 컬럼을 찾을 수 없습니다.")
        day_map = self._build_day_map(day_columns)

        records = self._build_records(df, day_columns, day_map)
        plan_long = self._build_plan_long(df, day_columns, day_map)
        machine_summary = self._summarize(plan_long, keys=["date", "machine"])
        model_summary = self._summarize(plan_long, keys=["date", "model"])
        daily_totals = self._summarize(plan_long, keys=["date"])

        return {
            "plan_type": self.plan_type,
            "plan_date": self.target_date.isoformat(),
            "sheet_name": sheet_name,
            "available_days": [day_map[col].isoformat() for col in day_columns],
            "records": records,
            "plan_long": plan_long,
            "machine_summary": machine_summary,
            "model_summary": model_summary,
            "daily_totals": daily_totals,
        }

    def _resolve_sheet_name(self, sheet_names: Iterable[str]) -> str:
        candidates = [
            f"{self.target_date.month}-{self.target_date.day}",
            f"{self.target_date.month}-{self.target_date.day:02d}",
        ]
        for candidate in candidates:
            if candidate in sheet_names:
                return candidate
        raise ProductionPlanProcessingError(
            f"{self.target_date.month}-{self.target_date.day} 시트를 찾을 수 없습니다."
        )

    def _extract_day_columns(self, columns: Iterable[Any]) -> List[Any]:
        day_cols: List[Any] = []
        for column in columns:
            if isinstance(column, (int, float)) and not pd.isna(column):
                day_cols.append(column)
            elif isinstance(column, str):
                stripped = column.strip()
                if stripped.isdigit():
                    day_cols.append(column)
        return day_cols

    def _build_day_map(self, day_columns: List[Any]) -> Dict[Any, date]:
        current_month = self.target_date.month
        current_year = self.target_date.year
        previous_day: Optional[int] = None
        mapping: Dict[Any, date] = {}
        for column in day_columns:
            day_number = self._to_day_number(column)
            if day_number is None:
                continue
            if previous_day is not None and day_number < previous_day:
                current_month += 1
                if current_month > 12:
                    current_month = 1
                    current_year += 1
            try:
                mapping[column] = date(current_year, current_month, day_number)
            except ValueError as exc:
                raise ProductionPlanProcessingError(f"{day_number}일을 날짜로 변환할 수 없습니다.") from exc
            previous_day = day_number
        return mapping

    def _to_day_number(self, value: Any) -> Optional[int]:
        if isinstance(value, (int, float)) and not pd.isna(value):
            return int(value)
        if isinstance(value, str) and value.strip().isdigit():
            return int(value.strip())
        return None

    def _build_records(
        self,
        df: pd.DataFrame,
        day_columns: List[Any],
        day_map: Mapping[Any, date],
    ) -> List[Dict[str, Any]]:
        records: List[Dict[str, Any]] = []
        for _, row in df.iterrows():
            base = {
                "machine": self._clean_str(row.get("machine")),
                "lot_no": self._clean_str(row.get("lot_no")),
                "model": self._clean_str(row.get("model")),
                "part_spec": self._clean_str(row.get("part_spec") or row.get("spec_detail")),
                "fg_part_no": self._clean_str(row.get("fg_part_no")),
                "sg_part_no": self._clean_str(row.get("sg_part_no")),
                "material": self._clean_str(row.get("material")),
                "color": self._clean_str(row.get("color")),
                "delivery_date": self._clean_date(row.get("delivery_date")),
                "lot_qty": self._clean_number(row.get("lot_qty")),
                "produced_qty": self._clean_number(row.get("produced_qty")),
                "req_qty": self._clean_number(row.get("req_qty")),
                "plan_type": self.plan_type,
                "daily_plan": [],
            }
            for column in day_columns:
                qty = self._clean_plan_qty(row.get(column))
                if not qty or qty <= 0:
                    continue
                if column not in day_map:
                    continue
                base["daily_plan"].append(
                    {
                        "date": day_map[column].isoformat(),
                        "plan_qty": qty,
                    }
                )
            records.append(base)
        return records

    def _build_plan_long(
        self,
        df: pd.DataFrame,
        day_columns: List[Any],
        day_map: Mapping[Any, date],
    ) -> List[Dict[str, Any]]:
        id_vars = [
            col
            for col in [
                "original_order", # Preserve order
                "machine",
                "lot_no",
                "model",
                "part_spec",
                "fg_part_no",
                "sg_part_no",
                "material",
                "color",
            ]
            if col in df.columns
        ]
        melted = df.melt(id_vars=id_vars, value_vars=day_columns, var_name="day", value_name="plan_qty")
        melted = melted.dropna(subset=["plan_qty"])
        melted["plan_qty"] = pd.to_numeric(melted["plan_qty"], errors="coerce")
        melted["plan_qty"] = melted["plan_qty"].round()
        melted = melted[melted["plan_qty"] > 0]

        # Keys for grouping, EXCLUDING original_order
        agg_keys = [col for col in id_vars if col != 'original_order' and col in melted.columns]
        agg_keys.append("day")

        if agg_keys:
            melted['plan_qty'] = melted['plan_qty'].fillna(0).astype(int)

            # Group by plan identifiers and aggregate: sum quantities and get the MIN original_order
            aggregated = melted.groupby(agg_keys, as_index=False, dropna=False).agg(
                plan_qty=('plan_qty', 'sum'),
                original_order=('original_order', 'min') 
            )
        else:
            aggregated = melted
            
        # Re-sort the entire aggregated dataframe by the original excel order
        if 'original_order' in aggregated.columns:
            aggregated = aggregated.sort_values(by='original_order').reset_index(drop=True)

        payload: List[Dict[str, Any]] = []
        for _, row in aggregated.iterrows():
            plan_date = day_map.get(row["day"])
            if not plan_date:
                continue
            payload.append(
                {
                    "original_order": row.get("original_order"),
                    "machine": self._clean_str(row.get("machine")),
                    "lot_no": self._clean_str(row.get("lot_no")),
                    "model": self._clean_str(row.get("model")),
                    "part_spec": self._clean_str(row.get("part_spec")),
                    "fg_part_no": self._clean_str(row.get("fg_part_no")),
                    "sg_part_no": self._clean_str(row.get("sg_part_no")),
                    "material": self._clean_str(row.get("material")),
                    "color": self._clean_str(row.get("color")),
                    "date": plan_date.isoformat(),
                    "plan_qty": int(row.get("plan_qty") or 0),
                    "plan_type": self.plan_type,
                }
            )
        return payload

    def _summarize(self, rows: List[Dict[str, Any]], keys: List[str]) -> List[Dict[str, Any]]:
        summary: Dict[str, Dict[str, Any]] = {}
        for row in rows:
            key_parts = [row.get(key) or "" for key in keys]
            summary_key = "|".join(key_parts)
            if summary_key not in summary:
                summary[summary_key] = {key: row.get(key) for key in keys}
                summary[summary_key]["plan_qty"] = 0
            summary[summary_key]["plan_qty"] += row.get("plan_qty") or 0
        return sorted(summary.values(), key=lambda item: tuple(item.get(key) or "" for key in keys))

    def _clean_str(self, value: Any) -> Optional[str]:
        if value is None or (isinstance(value, float) and pd.isna(value)):
            return None
        text = str(value).strip()
        return text or None

    def _clean_number(self, value: Any) -> Optional[float]:
        if value is None or (isinstance(value, float) and pd.isna(value)):
            return None
        try:
            number = float(value)
        except (TypeError, ValueError):
            return None
        if abs(number) < 1e-6:
            return 0
        return number

    def _clean_plan_qty(self, value: Any) -> Optional[int]:
        number = self._clean_number(value)
        if number is None:
            return None
        rounded = int(round(number))
        return rounded

    def _clean_date(self, value: Any) -> Optional[str]:
        if value in (None, "", " "):
            return None
        if isinstance(value, datetime):
            return value.date().isoformat()
        if isinstance(value, date):
            return value.isoformat()
        parsed = pd.to_datetime(value, errors="coerce")
        if pd.isna(parsed):
            return None
        return parsed.date().isoformat()

    def _filter_machine_rows(self, df: pd.DataFrame) -> pd.DataFrame:
        if "machine" not in df.columns:
            raise ProductionPlanProcessingError("설비 컬럼을 찾을 수 없습니다.")

        if self.plan_type == "injection":
            machine = df["machine"].astype(str).str.strip()
            mask = machine.str.match(r"^\d+T-\d+$", na=False)
            filtered = df[mask].copy()
            return filtered
        elif self.plan_type == "machining":
            # For machining, we assume any non-empty machine name is valid.
            machine = df["machine"].astype(str).str.strip()
            mask = machine.notna() & (machine != '')
            filtered = df[mask].copy()
            return filtered

        # Fallback for any other plan types
        return df
