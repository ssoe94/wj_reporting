def calculate_counter_increment(previous, current, reset_ratio_threshold=0.2):
    """Return one cumulative shot-counter delta using the shared reset policy.

    An initial reading is a baseline. A drop to at most 20% of the previous
    reading is treated as a reset; smaller corrections contribute no output.
    The caller must process every observed sample before chart bucketing.
    """
    if previous is None or current is None:
        return 0.0
    previous, current = float(previous), float(current)
    if current >= previous:
        return current - previous
    return current if previous > 0 and 0 <= current / previous <= reset_ratio_threshold else 0.0


def calculate_cumulative_counter_delta(values, baseline=None, reset_ratio_threshold=0.2):
    """
    Sum production from a cumulative MES counter.

    If a baseline before the production window is missing, the first in-window
    counter value is only a starting point. Counting it as output turns a
    machine lifetime counter into a same-day quantity.
    """
    previous = baseline
    total = 0.0

    for value in values:
        if value is None:
            continue

        current = float(value)
        if previous is None:
            previous = current
            continue

        delta = calculate_counter_increment(previous, current, reset_ratio_threshold)

        if delta > 0:
            total += delta
        previous = current

    return int(round(total))
