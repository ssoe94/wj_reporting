"""Decode the ASCII frames observed from the connected scale.

Status and mode are preserved verbatim until the device manual is confirmed.
No weight judgement or print trigger is performed here.
"""
from dataclasses import dataclass
from decimal import Decimal
import re


FRAME = re.compile(
    r"(?P<status>ST|US),(?P<mode>[A-Z]{2}),(?P<sign>[+-]) *"
    r"(?P<value>\d+(?:\.\d+)?) +(?P<unit>kg|g)"
)


@dataclass(frozen=True)
class Reading:
    value: str
    unit: str
    grams: str
    status: str
    mode: str
    raw: str


def parse_frame(frame: bytes):
    try:
        raw = frame.decode("ascii").strip("\r\n")
    except UnicodeDecodeError:
        return None
    match = FRAME.fullmatch(raw)
    if match is None:
        return None
    value = ("-" if match["sign"] == "-" else "") + match["value"]
    grams = Decimal(value) * (1000 if match["unit"] == "kg" else 1)
    return Reading(value, match["unit"], format(grams, "f"),
                   match["status"], match["mode"], raw)


class FrameDecoder:
    """Keep split lines together; reject truncated or excessively long frames."""

    def __init__(self):
        self.buffer = bytearray()
        self.discarding = False

    def feed(self, chunk: bytes):
        results = []
        for byte in chunk:
            if byte == 10:
                results.append(None if self.discarding else parse_frame(bytes(self.buffer)))
                self.buffer.clear()
                self.discarding = False
            elif not self.discarding:
                self.buffer.append(byte)
                if len(self.buffer) > 256:
                    self.buffer.clear()
                    self.discarding = True
        return results
