"""Machine labels shown by WJ, independent of MES telemetry identifiers."""


def display_tonnage(machine_no, source_tonnage):
    # MES identifies machine 7 as 1300T-7; its physical rating is 1800T.
    return '1800T' if int(machine_no) == 7 else source_tonnage
