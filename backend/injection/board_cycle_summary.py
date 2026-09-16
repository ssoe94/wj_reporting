"""Build all public part summaries with one bounded archive scan per cache fill."""
from datetime import timedelta

from django.core.cache import cache

from .cycle_time_history import read_cycle_time_history, normalized_part


def read_board_part_summary(part_no, end):
    start = end - timedelta(days=29)
    key = f'board-part-summaries-v2:{end}'
    summaries = cache.get(key)
    if summaries is None:
        history = read_cycle_time_history(start, end, hourly_details=False)
        groups = {}
        for row in history['daily']:
            for part in row['parts']:
                name = normalized_part(part.get('part_no'))
                if not name:
                    continue
                daily = groups.setdefault(name, {})
                group = daily.setdefault(row['business_date'], {'seconds': 0, 'shots': 0, 'machines': set()})
                group['machines'].add(row['machine_number'])
                if part['cycle_time_seconds'] is not None and part['shot_count'] > 0:
                    group['seconds'] += part['positive_interval_seconds']
                    group['shots'] += part['shot_count']
        summaries = {}
        for name, daily in groups.items():
            days, seconds, shots = [], 0, 0
            for offset in range(30):
                day = (start + timedelta(days=offset)).isoformat()
                group = daily.get(day, {'seconds': 0, 'shots': 0, 'machines': set()})
                seconds += group['seconds']
                shots += group['shots']
                days.append({'business_date': day,
                             'cycle_time_seconds': round(group['seconds'] / group['shots'], 1) if group['shots'] else None,
                             'machine_numbers': sorted(group['machines'])})
            summaries[name] = {'cycle_time_seconds': round(seconds / shots, 2) if shots else None, 'daily': days}
        cache.set(key, summaries, 300)
    empty = {'cycle_time_seconds': None, 'daily': [
        {'business_date': (start + timedelta(days=offset)).isoformat(), 'cycle_time_seconds': None, 'machine_numbers': []}
        for offset in range(30)]}
    return {'part_no': part_no, 'start_date': start.isoformat(), 'end_date': end.isoformat(),
            **summaries.get(normalized_part(part_no), empty)}
