"""Weight calibration and inspection rules, independent of hardware and UI.

All weights are grams. The caller supplies fresh software-stable samples;
this module never talks to a scale or sends a print job.
"""
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Optional


LIMIT_PERCENT = Decimal("5")
CALIBRATION_LIMIT_PERCENT = Decimal("5")
INSPECTION_RULE = "unit_5pct_sqrt_quantity_v1"
EMPTY_THRESHOLD_G = Decimal("2")
MIN_UNIT_WEIGHT_G = EMPTY_THRESHOLD_G * 2


def _decimal(value, label="중량"):
    try:
        result = Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        raise ValueError(f"{label}은 유효한 숫자여야 합니다.") from None
    if not result.is_finite():
        raise ValueError(f"{label}은 유한한 숫자여야 합니다.")
    return result


def _identity(value, label):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label}을 선택해 주세요.")
    return value.strip()


def _fit_unit(weights):
    return sum(Decimal(n) * weight for n, weight in enumerate(weights, 1)) / Decimal("55")


def _validate_calibration(weights, unit_weight):
    if len(weights) != 5:
        raise ValueError("1개부터 5개까지 총 5회의 캘리브레이션이 필요합니다.")
    if any(weight <= 0 for weight in weights):
        raise ValueError("캘리브레이션 중량은 영점을 제외하고 0 g보다 커야 합니다.")
    if any(later <= earlier for earlier, later in zip(weights, weights[1:])):
        raise ValueError("제품 수량을 늘릴 때마다 총중량도 증가해야 합니다.")
    if unit_weight <= MIN_UNIT_WEIGHT_G:
        raise ValueError(f"현재 빈 저울 기준이 {EMPTY_THRESHOLD_G} g이므로 개당 중량은 {MIN_UNIT_WEIGHT_G} g보다 커야 합니다.")
    for quantity, actual in enumerate(weights, 1):
        expected = unit_weight * quantity
        # Compare without dividing so the exact 5% boundary always fails.
        # Registration consistency is separate from production acceptance;
        # keep existing validated calibration records compatible.
        if abs(actual - expected) * 100 >= expected * CALIBRATION_LIMIT_PERCENT:
            error = abs(actual - expected) / expected * 100
            raise ValueError(
                f"{quantity}개 캘리브레이션이 기준에서 {error:.2f}% 벗어났습니다. "
                "허용 오차는 5% 미만입니다. 수량과 영점을 확인하고 다시 진행해 주세요."
            )


@dataclass(frozen=True)
class WeightProfile:
    size: str
    part_no: str
    unit_weight_g: Decimal
    calibration_g: tuple
    calibrated_at: str

    def __post_init__(self):
        object.__setattr__(self, "size", _identity(self.size, "모델"))
        object.__setattr__(self, "part_no", _identity(self.part_no, "PART"))
        unit = _decimal(self.unit_weight_g, "개당 중량")
        if not isinstance(self.calibration_g, (tuple, list)):
            raise ValueError("캘리브레이션 중량 목록이 잘못되었습니다.")
        weights = tuple(_decimal(value) for value in self.calibration_g)
        _validate_calibration(weights, unit)
        if unit != _fit_unit(weights):
            raise ValueError("저장된 개당 중량과 캘리브레이션 기록이 일치하지 않습니다.")
        try:
            timestamp = datetime.fromisoformat(self.calibrated_at)
            if timestamp.tzinfo is None:
                raise ValueError()
        except (TypeError, ValueError):
            raise ValueError("캘리브레이션 일시가 잘못되었습니다.") from None
        object.__setattr__(self, "unit_weight_g", unit)
        object.__setattr__(self, "calibration_g", weights)

    @property
    def key(self):
        return self.size, self.part_no

    @property
    def empty_threshold_g(self):
        return EMPTY_THRESHOLD_G


class CalibrationSession:
    """Record cumulative quantities 1..5 against an explicitly confirmed tare."""

    def __init__(self, size, part_no, tare_g):
        self.size = _identity(size, "모델")
        self.part_no = _identity(part_no, "PART")
        self.tare_g = _decimal(tare_g, "빈 저울 중량")
        self._weights = []

    @property
    def next_quantity(self):
        return len(self._weights) + 1 if len(self._weights) < 5 else None

    @property
    def calibration_g(self):
        return tuple(self._weights)

    def record(self, quantity, raw_g):
        if isinstance(quantity, bool) or not isinstance(quantity, int) or quantity != self.next_quantity:
            raise ValueError("안내된 수량 순서대로 1개부터 5개까지 측정해 주세요.")
        net = _decimal(raw_g) - self.tare_g
        if net <= EMPTY_THRESHOLD_G:
            raise ValueError(f"제품을 올려 주세요. 순중량이 {EMPTY_THRESHOLD_G} g보다 커야 합니다.")
        if self._weights and net <= self._weights[-1]:
            raise ValueError("제품을 한 개 더 올려 주세요. 총중량이 증가해야 합니다.")
        self._weights.append(net)
        return net

    def finish(self):
        if len(self._weights) != 5:
            raise ValueError("1개부터 5개까지 총 5회의 캘리브레이션이 필요합니다.")
        weights = tuple(self._weights)
        return WeightProfile(
            self.size, self.part_no, _fit_unit(weights), weights,
            datetime.now(timezone.utc).isoformat(timespec="seconds"),
        )


@dataclass(frozen=True)
class WeightDecision:
    accepted: bool
    quantity: Optional[int]
    expected_g: Optional[Decimal]
    deviation_percent: Optional[Decimal]
    reason: str
    difference_g: Optional[Decimal] = None
    limit_g: Optional[Decimal] = None


def evaluate_weight(net_g, profile):
    """Infer 1..5 products and require error < unit weight * 5% * sqrt(n).

    The square-root rule is a trial inspection limit, not a confidence
    interval estimated from the five calibration readings.
    """
    if not isinstance(profile, WeightProfile):
        raise ValueError("검증된 모델/PART 중량 데이터가 필요합니다.")
    actual = _decimal(net_g)
    if actual <= profile.empty_threshold_g:
        return WeightDecision(False, None, None, None, "제품 중량이 없거나 영점보다 낮습니다.")
    quantity = min(range(1, 6), key=lambda n: abs(actual - n * profile.unit_weight_g))
    expected = profile.unit_weight_g * quantity
    difference = abs(actual - expected)
    deviation = difference / expected * 100
    unit_limit = profile.unit_weight_g * LIMIT_PERCENT / 100
    limit = unit_limit * Decimal(quantity).sqrt()
    # Both sides are nonnegative. Squaring avoids using a rounded square
    # root (or the displayed gram limit) to decide an exact boundary.
    accepted = difference ** 2 < unit_limit ** 2 * quantity
    reason = (
        f"{quantity}개 정상: 중량 차이 {difference:.3f} g ({deviation:.2f}%) · "
        f"허용 편차 약 {limit:.6f} g 미만 (단품 5% × √수량)."
        if accepted else
        f"1~5개 허용 중량에 맞지 않습니다. 가장 가까운 {quantity}개 기준에서 "
        f"{difference:.3f} g ({deviation:.2f}%) 차이 · "
        f"허용 편차 약 {limit:.6f} g 미만 (단품 5% × √수량)."
    )
    return WeightDecision(accepted, quantity, expected, deviation, reason, difference, limit)


@dataclass(frozen=True)
class CycleEvent:
    status: str
    net_g: Optional[Decimal] = None
    decision: Optional[WeightDecision] = None


class CycleGate:
    """One PASS/NG event per load, rearmed only by a stable empty scale.

    Call reset() on disconnect, stale input, model change, or a mode change.
    A confirmed empty scale must then establish a new baseline. Automatic
    confirmation also requires a fresh reading within the physical ±2 g band;
    stability alone never establishes an empty baseline.
    """

    def __init__(self):
        self.reset()

    def reset(self):
        self.baseline_g = None
        self.armed = False

    @property
    def tare_g(self):
        return self.baseline_g

    @property
    def latched(self):
        return self.baseline_g is not None and not self.armed

    def confirm_empty(self, raw_g):
        self.baseline_g = _decimal(raw_g, "빈 저울 중량")
        self.armed = True

    def observe(self, raw_g, profile, stable=True):
        if self.baseline_g is None:
            return CycleEvent("waiting_empty")
        net = _decimal(raw_g) - self.baseline_g
        if not stable:
            return CycleEvent("unstable", net)
        if abs(net) <= profile.empty_threshold_g:
            self.armed = True
            return CycleEvent("empty", net)
        if not self.armed:
            return CycleEvent("latched", net)
        decision = evaluate_weight(net, profile)
        self.armed = False
        return CycleEvent("accepted" if decision.accepted else "rejected", net, decision)
