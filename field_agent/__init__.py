"""WJ field station runtime."""

try:
    from ._build_version import __version__
except ModuleNotFoundError as exc:
    if exc.name != __name__ + "._build_version":
        raise
    __version__ = "0.1.0"
