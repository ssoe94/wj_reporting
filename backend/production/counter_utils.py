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

        if current >= previous:
            delta = current - previous
        else:
            is_counter_reset = previous > 0 and (current / previous) <= reset_ratio_threshold
            delta = current if is_counter_reset else 0

        if delta > 0:
            total += delta
        previous = current

    return int(round(total))
