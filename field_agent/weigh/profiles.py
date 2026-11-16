"""Atomic local storage for validated weight calibration profiles."""

import json
import os
from pathlib import Path
import tempfile

from .rules import WeightProfile, _identity


class ProfileStoreError(ValueError):
    pass


class ProfileStore:
    """Validated model/PART profiles with atomic replacement on save.

    Corrupt or unsupported existing files cause a visible error and are never
    silently treated as an empty profile collection.
    """

    def __init__(self, path):
        self.path = Path(path)

    def all(self):
        if not self.path.exists():
            return []
        try:
            document = json.loads(self.path.read_text(encoding="utf-8"))
            if (not isinstance(document, dict)
                    or type(document.get("version")) is not int
                    or document["version"] != 1
                    or not isinstance(document.get("profiles"), list)):
                raise ValueError("지원하지 않는 중량 데이터 형식입니다.")
            result = []
            seen = set()
            for row in document["profiles"]:
                if not isinstance(row, dict):
                    raise ValueError("중량 데이터 항목 형식이 잘못되었습니다.")
                profile = WeightProfile(
                    size=row["size"], part_no=row["part_no"],
                    unit_weight_g=row["unit_weight_g"],
                    calibration_g=row["calibration_g"], calibrated_at=row["calibrated_at"],
                )
                if profile.key in seen:
                    raise ValueError("같은 모델/PART의 중량 데이터가 중복되었습니다.")
                seen.add(profile.key)
                result.append(profile)
            return result
        except (OSError, UnicodeError, ValueError, KeyError, TypeError) as exc:
            raise ProfileStoreError(
                f"중량 데이터 파일을 읽을 수 없습니다 ({self.path}). "
                f"기존 파일은 덮어쓰지 않습니다. 원인: {exc}"
            ) from exc

    def get(self, size, part_no):
        key = (_identity(size, "모델"), _identity(part_no, "PART"))
        return next((profile for profile in self.all() if profile.key == key), None)

    def save(self, profile):
        if not isinstance(profile, WeightProfile):
            raise ProfileStoreError("검증된 중량 데이터만 저장할 수 있습니다.")
        profiles = {item.key: item for item in self.all()}
        profiles[profile.key] = profile
        document = {
            "version": 1,
            "profiles": [
                {
                    "size": item.size, "part_no": item.part_no,
                    "unit_weight_g": str(item.unit_weight_g),
                    "calibration_g": [str(weight) for weight in item.calibration_g],
                    "calibrated_at": item.calibrated_at,
                }
                for item in sorted(profiles.values(), key=lambda item: item.key)
            ],
        }
        temporary_path = None
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(
                mode="w", encoding="utf-8", dir=self.path.parent,
                prefix=self.path.name + ".", suffix=".tmp", delete=False,
            ) as handle:
                temporary_path = Path(handle.name)
                json.dump(document, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_path, self.path)
        except OSError as exc:
            raise ProfileStoreError(f"중량 데이터를 저장할 수 없습니다: {exc}") from exc
        finally:
            if temporary_path is not None:
                temporary_path.unlink(missing_ok=True)
