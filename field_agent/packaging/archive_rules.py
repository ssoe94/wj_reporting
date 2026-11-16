"""Archive names shared by the offline builder and installer."""

import re
import stat


_VERSION = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,47}", re.ASCII)
_NAME = re.compile(r"[A-Za-z0-9_.-]{1,128}", re.ASCII)
_RESERVED = {"CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"} | {
    prefix + str(number) for prefix in ("COM", "LPT") for number in range(10)
}
_SHA256 = re.compile(r"[0-9a-f]{64}", re.ASCII)


def archive_parts(name):
    """Validate a portable ZIP path and return its case-preserving components."""
    if name.endswith("/"):
        name = name[:-1]
    parts = tuple(name.split("/"))
    if any(not _NAME.fullmatch(part) or part.endswith(".") or
           part.split(".")[0].upper() in _RESERVED for part in parts):
        raise ValueError("Unsafe package path")
    return parts


def release_version(value):
    if not isinstance(value, str) or not _VERSION.fullmatch(value):
        raise ValueError("Invalid portable release version")
    archive_parts(value)
    return value


def checksum_rows(raw):
    """Parse the project's GNU-style SHA256SUMS file."""
    checksums = {}
    seen = set()
    for line in raw.decode("ascii").splitlines():
        digest, separator, name = line.partition("  ")
        if not separator or not _SHA256.fullmatch(digest) or name.endswith("/"):
            raise ValueError("Invalid SHA-256 list")
        key = "/".join(archive_parts(name)).lower()
        if key in seen:
            raise ValueError("Duplicate SHA-256 path")
        seen.add(key)
        checksums[name] = digest
    return checksums


def archive_members(archive):
    """Reject aliases, links and conflicts before extraction starts."""
    members = []
    found = {}
    explicit = set()
    for item in archive.infolist():
        # orig_filename preserves an embedded NUL that ZipInfo would truncate.
        parts = archive_parts(item.orig_filename)
        is_directory = item.is_dir()
        kind = stat.S_IFMT(item.external_attr >> 16)
        if kind not in {0, stat.S_IFDIR if is_directory else stat.S_IFREG} or item.external_attr & 0x400:
            raise ValueError("Unsupported package archive entry")
        key = tuple(part.lower() for part in parts)
        if key in explicit:
            raise ValueError("Duplicate package archive entry")
        explicit.add(key)
        for index in range(1, len(parts) + 1):
            parent = key[:index]
            details = (parts[:index], index < len(parts) or is_directory)
            if found.setdefault(parent, details) != details:
                raise ValueError("Conflicting package archive paths")
        if not is_directory:
            members.append((item, parts))
    return members
