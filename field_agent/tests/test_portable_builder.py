import hashlib
import json
from pathlib import Path
import stat
import struct
from tempfile import TemporaryDirectory
import unittest
from zipfile import ZipFile, ZipInfo

from field_agent.packaging.archive_rules import archive_members, archive_parts, checksum_rows
from field_agent.packaging.build_portable import build_portable


_PATCH = (b"diff --git a/batch_inspection/app.py b/batch_inspection/app.py\n"
          b"diff --git a/batch_inspection/ui_language.py b/batch_inspection/ui_language.py\n")


class PortableBuilderTests(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory(prefix="패키지 검증 ")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.inputs = self.root / "입력"
        self.inputs.mkdir()
        self.source = self.root / "checkout"
        self.source.mkdir()
        self.output = self.root / "출력 폴더" / "WJ Field.zip"
        self.pins = self.inputs / "SHA256SUMS"
        self.patch = self.inputs / "approved.patch"
        self.patch.write_bytes(_PATCH)
        for relative, data in {
            "field_agent/__init__.py": b"",
            "field_agent/start.cmd": b"@echo off\r\n",
            "field_agent/static/index.html": b"<html></html>",
            "field_agent/packaging/windows_files/install.cmd": b"@echo off\r\n",
            "field_agent/packaging/UV_COMPONENT.md": b"# UV\n",
            "field_agent/tests/test_private_data.py": b"unshipped",
            "docs/field-monitoring/operations/vision-operator.md": b"# Vision\n",
        }.items():
            path = self.source / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)

    def pin(self, *paths):
        rows = [hashlib.sha256(path.read_bytes()).hexdigest() + "  " + path.name + "\n" for path in paths]
        self.pins.write_bytes("".join(rows).encode("ascii"))

    def build(self, **options):
        return build_portable(profile="win7", version="0.2.0-test", output=self.output,
                              pins=self.pins, source_root=self.source, uv_patch=self.patch, **options)

    def runtime(self, name="python-3.8.10-embed-amd64.zip"):
        runtime = self.inputs / name
        digits = "".join(name.split("-")[1].split(".")[:2])
        exe = bytearray(70)
        exe[:2] = b"MZ"
        struct.pack_into("<I", exe, 60, 64)
        exe[64:] = b"PE\0\0\x64\x86"
        with ZipFile(runtime, "w") as bundle:
            for filename in ("python.exe", "pythonw.exe", "python3.dll", "python" + digits + ".dll",
                             "python" + digits + ".zip", "python" + digits + "._pth", "sqlite3.dll",
                             "_sqlite3.pyd", "_ssl.pyd"):
                bundle.writestr(filename, exe if filename == "python.exe" else b"synthetic bytes")
        return runtime

    def wheel(self):
        wheel = self.inputs / "pyserial-3.5-py2.py3-none-any.whl"
        with ZipFile(wheel, "w") as bundle:
            bundle.writestr("serial/__init__.py", "__version__ = 'fake'")
            bundle.writestr("pyserial-3.5.dist-info/WHEEL", "Root-Is-Purelib: true\nTag: py3-none-any\n")
            bundle.writestr("pyserial-3.5.data/scripts/serial-tool", "discard launcher utility")
        return wheel

    def test_skeleton_has_complete_checksums_and_reproducible_output(self):
        self.pin(self.patch)
        self.assertTrue(self.build()["skeleton"])
        package = self.output.read_bytes()
        self.build()
        self.assertEqual(self.output.read_bytes(), package)
        hash_file = self.output.with_name(self.output.name + ".sha256")
        self.assertEqual(hash_file.read_text("utf-8"), hashlib.sha256(package).hexdigest() + "  WJ Field.zip\n")
        prefix = "WJField/versions/0.2.0-test/"
        with ZipFile(self.output) as archive:
            self.assertEqual(archive.read("WJField/bootstrap.cmd"), b'@set "WJ_PORTABLE_VERSION=0.2.0-test"\r\n')
            checksums = checksum_rows(archive.read(prefix + "SHA256SUMS"))
            files = {name[len(prefix):] for name in archive.namelist()
                     if name.startswith(prefix) and name != prefix + "SHA256SUMS"}
            self.assertEqual(set(checksums), files)
            for name, digest in checksums.items():
                self.assertEqual(hashlib.sha256(archive.read(prefix + name)).hexdigest(), digest)
            self.assertIn("components/uv/batch-inspection-ko-zh.patch", files)
            self.assertIn("docs/field-monitoring/operations/vision-operator.md", files)
            self.assertIn("python/TEST-ONLY.txt", files)
            self.assertFalse(any("data/" in name or "private" in name for name in archive.namelist()))

    def test_verified_runtime_and_pure_wheel_are_staged_in_isolated_search_path(self):
        runtime, wheel = self.runtime(), self.wheel()
        self.pin(runtime, wheel, self.patch)
        manifest = self.build(python_zip=runtime, wheels=[wheel])
        self.assertFalse(manifest["skeleton"])
        self.assertEqual(manifest["architecture"], "amd64")
        self.assertEqual(manifest["python_version"], "3.8.10")
        prefix = "WJField/versions/0.2.0-test/"
        with ZipFile(self.output) as archive:
            self.assertEqual(json.loads(archive.read(prefix + "BUILD-MANIFEST.json")), manifest)
            self.assertIn(prefix + "python/Lib/site-packages/serial/__init__.py", archive.namelist())
            self.assertEqual(archive.read(prefix + "python/python38._pth"), b"python38.zip\n.\n..\nLib\\site-packages\n")
            self.assertFalse(any(".data/" in name for name in archive.namelist()))

    def test_rejects_bad_digest_before_parsing_input_zip(self):
        runtime, wheel = self.runtime(), self.wheel()
        self.pin(runtime, wheel, self.patch)
        runtime.write_bytes(b"corrupt")
        with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
            self.build(python_zip=runtime, wheels=[wheel])
        self.assertFalse(self.output.exists())

    def test_rejects_runtime_for_other_profile(self):
        runtime, wheel = self.runtime("python-3.12.10-embed-amd64.zip"), self.wheel()
        self.pin(runtime, wheel, self.patch)
        with self.assertRaisesRegex(ValueError, "does not match"):
            self.build(python_zip=runtime, wheels=[wheel])

    def test_win10_stages_a_python_312_runtime(self):
        runtime, wheel = self.runtime("python-3.12.10-embed-amd64.zip"), self.wheel()
        self.pin(runtime, wheel, self.patch)
        manifest = build_portable(profile="win10", version="0.2.0-test", output=self.output,
                                  pins=self.pins, source_root=self.source, uv_patch=self.patch,
                                  python_zip=runtime, wheels=[wheel])
        self.assertEqual(manifest["python_minor"], "3.12")
        self.assertEqual(manifest["python_version"], "3.12.10")
        self.assertFalse(manifest["skeleton"])

    def test_package_paths_are_safe_on_windows(self):
        for invalid in ("../../secret", "C:/escape", "a\\b", "root/NUL.txt", "root/dir./x", "/x", "file\x00x"):
            with self.subTest(path=invalid), self.assertRaises(ValueError):
                archive_parts(invalid)
        for first, second in (("root/File", "root/file"), ("root/Dir/item", "root/dir/next"),
                              ("root/file", "root/file/child")):
            archive_path = self.inputs / "alias.zip"
            with ZipFile(archive_path, "w") as archive:
                archive.writestr(first, "x")
                archive.writestr(second, "y")
            with ZipFile(archive_path) as archive, self.assertRaises(ValueError):
                archive_members(archive)
        archive_path = self.inputs / "link.zip"
        with ZipFile(archive_path, "w") as archive:
            entry = ZipInfo("root/link")
            entry.external_attr = (stat.S_IFLNK | 0o777) << 16
            archive.writestr(entry, "../target")
        with ZipFile(archive_path) as archive, self.assertRaises(ValueError):
            archive_members(archive)
