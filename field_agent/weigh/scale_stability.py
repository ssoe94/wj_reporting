"""Software stability from the full min/max range of a continuous time window."""
from collections import deque
from decimal import Decimal, InvalidOperation
import math

DEFAULT_TOLERANCE_GRAMS = "2.0"

class RangeStability:
    def __init__(self, hold_seconds=1.0, tolerance_grams=DEFAULT_TOLERANCE_GRAMS, max_gap_seconds=0.5):
        if not math.isfinite(hold_seconds) or hold_seconds <= 0:
            raise ValueError("hold_seconds must be finite and positive")
        if not math.isfinite(max_gap_seconds) or max_gap_seconds <= 0:
            raise ValueError("max_gap_seconds must be finite and positive")
        try:
            self.tolerance = Decimal(tolerance_grams)
            if not self.tolerance.is_finite() or self.tolerance < 0:
                raise ValueError()
        except (InvalidOperation, ValueError, TypeError):
            raise ValueError("허용 변동폭은 0 이상의 숫자(g)로 입력해 주세요.") from None
        self.hold_seconds = hold_seconds
        self.max_gap_seconds = max_gap_seconds
        self.reset()

    def reset(self):
        self.samples = deque()
        self.mode = None

    def update(self, grams, mode, now):
        try:
            value = Decimal(grams)
            if not value.is_finite():
                raise ValueError("Invalid weight")
        except (InvalidOperation, ValueError, TypeError, OverflowError):
            self.reset()
            return self.snapshot(now)
        if self.samples and (now - self.samples[-1][0] > self.max_gap_seconds
                             or now < self.samples[-1][0] or mode != self.mode):
            self.reset()
        self.mode = mode
        self.samples.append((now, value))
        cutoff = now - self.hold_seconds
        # Keep the sample at/before the boundary to cover a full interval
        # even when sampling times do not land on exact seconds.
        while len(self.samples) > 1 and self.samples[1][0] <= cutoff:
            self.samples.popleft()
        return self.snapshot(now)

    def snapshot(self, now):
        if self.samples and (now - self.samples[-1][0] > self.max_gap_seconds
                             or now < self.samples[-1][0]):
            self.reset()
        held = 0.0
        minimum = maximum = spread = None
        if self.samples:
            held = self.samples[-1][0] - self.samples[0][0]
            minimum = min(value for _, value in self.samples)
            maximum = max(value for _, value in self.samples)
            spread = maximum - minimum
        return {"stable": spread is not None and held >= self.hold_seconds and spread <= self.tolerance,
                "held_seconds": round(min(held, self.hold_seconds), 3),
                "required_seconds": self.hold_seconds,
                "tolerance_grams": format(self.tolerance, "f"),
                "min_grams": None if minimum is None else format(minimum, "f"),
                "max_grams": None if maximum is None else format(maximum, "f"),
                "range_grams": None if spread is None else format(spread, "f")}
