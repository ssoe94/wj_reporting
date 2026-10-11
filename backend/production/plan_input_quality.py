"""Canonical input eligibility states, including immutable legacy snapshots.

This is not a production inspection result. No approval or stored payload is
rewritten by normalization. The array wire format awaits the isolated MES trial.
"""
import json


def input_quality_states(value):
    if type(value) is str:
        if len(value) > 32:
            raise ValueError('Invalid input quality states.')
        try:
            value = json.loads(value)
        except (ValueError, TypeError):
            raise ValueError('Invalid input quality states.') from None
    if (type(value) is not list or not 1 <= len(value) <= 4
            or any(type(item) is not int or item not in (1, 2, 3, 4) for item in value)
            or len(set(value)) != len(value)):
        raise ValueError('Invalid input quality states.')
    return sorted(value)


def normalized_feeding_control(control):
    return {**control, 'inputQcState': input_quality_states(control['inputQcState'])}
