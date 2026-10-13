"""Unit tests for evidence identity; these do not claim sandbox enforcement."""
import shutil
import tempfile
from pathlib import Path
import unittest

from runtime_identity import capture_runtime_identity, assert_runtime_unchanged


class RuntimeIdentityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / "bin").mkdir()
        (self.root / "dist/src").mkdir(parents=True)
        self.runner = self.root / "bin/sandbox-runner"
        self.node = self.root / "node-fixture"
        self.runner.write_text("#!/bin/sh\nexec node dist/src/cli.js\n")
        self.node.write_bytes(b"fake-node-for-file-identity-only")
        (self.root / "package.json").write_text('{"type":"module"}')
        (self.root / "dist/src/cli.js").write_text("console.log('runtime')")

    def tearDown(self):
        self.temp.cleanup()

    def capture(self):
        return capture_runtime_identity(self.runner, self.node, self.root)

    def test_every_executed_component_changes_identity(self):
        for path in (self.runner, self.node, self.root / "package.json", self.root / "dist/src/cli.js"):
            with self.subTest(path=path.name):
                before = self.capture()
                saved = path.read_bytes()
                path.write_bytes(saved+b"\n")
                self.assertNotEqual(before["closure_sha256"], self.capture()["closure_sha256"])
                with self.assertRaises(AssertionError):
                    assert_runtime_unchanged(before, self.runner, self.node, self.root)
                path.write_bytes(saved)

    def test_added_and_removed_deployed_files_change_identity(self):
        before = self.capture()
        extra = self.root / "dist/src/later.js"
        extra.write_text("export const later = true")
        self.assertNotEqual(before["closure_sha256"], self.capture()["closure_sha256"])
        extra.unlink()
        self.assertEqual(before["closure_sha256"], self.capture()["closure_sha256"])

    def test_symlinked_closure_is_not_silently_omitted(self):
        (self.root / "dist/alias").symlink_to(self.root / "dist/src", target_is_directory=True)
        with self.assertRaises(ValueError):
            self.capture()

    def test_native_only_layout_is_rejected(self):
        shutil.rmtree(self.root / "dist")
        with self.assertRaises(ValueError):
            self.capture()

    def test_symlinked_dist_root_is_not_silently_followed(self):
        (self.root / "dist").rename(self.root / "actual-dist")
        (self.root / "dist").symlink_to(self.root / "actual-dist", target_is_directory=True)
        with self.assertRaises(ValueError):
            self.capture()

    def test_wrong_declared_root_is_rejected(self):
        with self.assertRaises(ValueError):
            capture_runtime_identity(self.runner, self.node, self.root.parent)


if __name__ == "__main__":
    unittest.main()
