"""Синтетический контракт F0; kernel policy и provider не читаются."""

import contextlib
import importlib.util
import io
import json
from pathlib import Path
import stat
import sys
import types
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
PROBE_PATH = Path(__file__).with_name("linux-apparmor-raw-policy-feasibility.py")


class FeasibilityContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not PROBE_PATH.is_file():
            raise AssertionError("maintained F0 probe must exist")
        spec = importlib.util.spec_from_file_location("f0_probe", PROBE_PATH)
        cls.probe = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.probe)

    def test_metadata_only_can_never_claim_feasibility(self):
        for package_output in [None, b"", b"linux-image-6.8.0-1-generic\t6.8.0-1.1\tlinux\t6.8.0-1.1\n"]:
            report = self.probe.collect_metadata(
                "Linux", "6.8.0-1-generic", {}, lambda _: b"Y\n",
                lambda _: package_output,
            )
            self.assertEqual(report["result"], "F0_SOURCE_EXPORT_CONTRACT_UNREVIEWED")
            self.assertEqual(report["exactKernelSourceRevision"], "UNAVAILABLE")
            self.assertEqual(report["rawPolicyRead"], "NOT_ATTEMPTED")
            self.assertNotIn("PASS", json.dumps(report))

    def test_reads_only_allowlisted_module_metadata_without_namespace(self):
        reads = []
        commands = []
        def read(path):
            reads.append(path)
            return b"Y\n"
        def command(args):
            commands.append(args)
            return None
        self.probe.collect_metadata("Linux", "6.8.0-1-generic", {}, read, command)
        self.assertEqual(set(reads), set(self.probe.METADATA_PATHS))
        self.assertTrue(all("/sys/module/apparmor/parameters/" in path for path in reads))
        self.assertEqual(len(commands), 1)
        self.assertEqual(commands[0][0], "/usr/bin/dpkg-query")
        self.assertNotIn("raw_data", str(reads + commands))
        self.assertNotIn("profiles", str(reads + commands))

    def test_identifiers_and_exceptions_never_disclose_untrusted_details(self):
        secret = "secret-policy-path\x1b[31m\n::error::injected"
        def failure(_):
            raise RuntimeError(secret)
        report = self.probe.collect_metadata("Linux", secret, {
            "ImageOS": secret, "ImageVersion": secret, "PRIVATE": secret,
        }, failure, failure)
        output = json.dumps(report)
        self.assertNotIn("secret", output)
        self.assertNotIn("::error", output)
        self.assertEqual(report["kernelRelease"], "UNAVAILABLE")

    def test_package_fields_are_bounded_strict_and_never_exact_source_evidence(self):
        metadata = b"linux-image-6.8.0-1-generic\t6.8.0-1.1\tlinux-signed\t6.8.0-1.1\napparmor\t4.0.1-0ubuntu0.24.04.3\tapparmor\t4.0.1-0ubuntu0.24.04.3\n"
        report = self.probe.collect_metadata("Linux", "6.8.0-1-generic", {
            "ImageOS": "ubuntu24", "ImageVersion": "20261004.327.1",
        }, lambda _: b"N\n", lambda _: metadata)
        self.assertEqual(report["kernelPackageVersion"], "6.8.0-1.1")
        self.assertEqual(report["kernelPackageSourceVersion"], "6.8.0-1.1")
        self.assertEqual(report["apparmorParserPackageVersion"], "4.0.1-0ubuntu0.24.04.3")
        self.assertEqual(report["binaryPolicyExport"], "DISABLED")
        self.assertEqual(report["exactKernelSourceRevision"], "UNAVAILABLE")
        for malformed in [metadata * 100, metadata + metadata, b"apparmor\t/private/path\tapparmor\t1\n", b"\xff"]:
            report = self.probe.collect_metadata("Linux", "6.8.0-1-generic", {}, lambda _: None, lambda _: malformed)
            self.assertEqual(report["apparmorParserPackageVersion"], "UNAVAILABLE")

    def test_non_linux_does_no_io_and_cli_refuses(self):
        def forbidden(_):
            raise AssertionError("non-Linux must not perform IO")
        report = self.probe.collect_metadata("Windows", "6.8.0", {}, forbidden, forbidden)
        self.assertEqual(report, {"schemaVersion": 1, "result": "F0_PLATFORM_UNSUPPORTED", "rawPolicyRead": "NOT_ATTEMPTED"})
        with patch.object(self.probe.platform, "system", return_value="Windows"):
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                self.assertEqual(self.probe.main(), 2)
            self.assertEqual(json.loads(output.getvalue()), report)

    def test_command_start_failure_is_sanitized(self):
        with patch.object(self.probe.subprocess, "Popen", side_effect=OSError("private credential")):
            self.assertIsNone(self.probe.bounded_package_query(["/usr/bin/dpkg-query"]))

    def fake_package_query(self, ready, payload=None, eof_wait_timeout=False):
        """Выполняет actual collector с fake child/pipe/selector, без OS process."""
        lifecycle = []
        class Pipe:
            def fileno(self):
                return 17
            def close(self):
                lifecycle.append("pipe-close")
        class Child:
            stdout = Pipe()
            def poll(self):
                return None
            def kill(self):
                lifecycle.append("kill")
            def wait(child, timeout=None):
                lifecycle.append(("wait", timeout))
                if timeout is not None and eof_wait_timeout:
                    raise self.probe.subprocess.TimeoutExpired("private-command", timeout, stderr=b"private-credential")
                return -9
        class Selector:
            def __enter__(self):
                return self
            def __exit__(self, *unused):
                lifecycle.append("selector-close")
            def register(self, pipe, events):
                self.registered = (pipe, events)
            def select(self, timeout):
                self.timeout = timeout
                return [object()] if ready else []
        child = Child()
        selector = Selector()
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(self.probe.subprocess, "Popen", return_value=child) as popen, patch.object(self.probe.selectors, "DefaultSelector", return_value=selector), patch.object(self.probe.os, "set_blocking") as set_blocking, patch.object(self.probe.os, "read", return_value=payload) as read, patch.object(self.probe.time, "monotonic", return_value=0), contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            self.assertIsNone(self.probe.bounded_package_query(["/usr/bin/dpkg-query"]))
        self.assertEqual(stdout.getvalue() + stderr.getvalue(), "")
        self.assertFalse(popen.call_args.kwargs["shell"])
        self.assertEqual(popen.call_args.kwargs["stderr"], self.probe.subprocess.DEVNULL)
        set_blocking.assert_called_once_with(17, False)
        self.assertEqual(selector.timeout, self.probe.COMMAND_TIMEOUT_SECONDS)
        if ready:
            read.assert_called_once_with(17, self.probe.METADATA_CAP + 1)
        else:
            read.assert_not_called()
        self.assertEqual(lifecycle[-3:], ["kill", ("wait", None), "pipe-close"])
        return lifecycle

    def test_command_actual_stdout_overflow_kills_reaps_and_closes_silently(self):
        payload = (b"private-credential" * self.probe.METADATA_CAP)[:self.probe.METADATA_CAP + 1]
        self.fake_package_query(ready=True, payload=payload)

    def test_command_selector_timeout_kills_reaps_and_closes_silently(self):
        self.fake_package_query(ready=False)

    def test_command_wait_timeout_kills_reaps_and_closes_silently(self):
        lifecycle = self.fake_package_query(ready=True, payload=b"", eof_wait_timeout=True)
        self.assertEqual(lifecycle[0], ("wait", self.probe.COMMAND_TIMEOUT_SECONDS))

    def test_reader_rejects_non_allowlisted_path_before_open(self):
        with patch.object(self.probe.os, "open", side_effect=AssertionError("must not open")):
            self.assertIsNone(self.probe.read_module_metadata("/sys/kernel/security/apparmor/policy/raw_data"))

    def test_reader_holds_nofollow_chain_and_closes_all_handles(self):
        calls = []
        closed = []
        def opened(path, flags, **kwargs):
            calls.append((path, flags, kwargs))
            return len(calls)
        object_stat = types.SimpleNamespace(st_dev=1, st_ino=2, st_mode=stat.S_IFREG | 0o444)
        with patch.object(self.probe.os, "O_NOFOLLOW", 0x10000, create=True), patch.object(self.probe.os, "O_DIRECTORY", 0x20000, create=True), patch.object(self.probe.os, "O_CLOEXEC", 0x40000, create=True), patch.object(self.probe.os, "O_NONBLOCK", 0x80000, create=True), patch.object(self.probe.os, "open", side_effect=opened), patch.object(self.probe.os, "read", side_effect=[b"Y\n", b""]), patch.object(self.probe.os, "fstat", return_value=object_stat), patch.object(self.probe.os, "close", side_effect=closed.append):
            self.assertEqual(self.probe.read_module_metadata(self.probe.METADATA_PATHS[0]), b"Y\n")
        self.assertEqual(calls[0][0], "/")
        self.assertEqual([call[0] for call in calls[1:]], ["sys", "module", "apparmor", "parameters", "enabled"])
        self.assertTrue(all(flags & 0x10000 for _, flags, _ in calls))
        self.assertEqual([kwargs["dir_fd"] for _, _, kwargs in calls[1:]], list(range(1, len(calls))))
        self.assertEqual(closed, list(range(len(calls), 0, -1)))

    def test_reader_caps_and_identity_races_refuse_without_details(self):
        object_stat = types.SimpleNamespace(st_dev=1, st_ino=2, st_mode=stat.S_IFREG | 0o444)
        changed = types.SimpleNamespace(st_dev=1, st_ino=3, st_mode=stat.S_IFREG | 0o444)
        for reads, stats in [([b"x" * (self.probe.METADATA_CAP + 1)], [object_stat]), ([b"Y\n", b""], [object_stat, changed])]:
            closed = []
            with patch.object(self.probe.os, "O_NOFOLLOW", 0x10000, create=True), patch.object(self.probe.os, "O_DIRECTORY", 0x20000, create=True), patch.object(self.probe.os, "O_CLOEXEC", 0x40000, create=True), patch.object(self.probe.os, "O_NONBLOCK", 0x80000, create=True), patch.object(self.probe.os, "open", side_effect=range(1, 7)), patch.object(self.probe.os, "read", side_effect=reads), patch.object(self.probe.os, "fstat", side_effect=stats), patch.object(self.probe.os, "close", side_effect=closed.append):
                self.assertIsNone(self.probe.read_module_metadata(self.probe.METADATA_PATHS[0]))
            self.assertEqual(closed, [6, 5, 4, 3, 2, 1])

    def test_workflow_stops_before_any_namespace_or_service_setup(self):
        workflow = PROBE_PATH.parent.parent / ".github/workflows/production-gates.yml"
        source = workflow.read_text(encoding="utf-8")
        probe = source.index("python -I -S -B scripts/linux-apparmor-raw-policy-feasibility.py")
        self.assertLess(probe, source.index("Start ephemeral runner user systemd manager"))
        self.assertLess(probe, source.index("linux-hermes-namespace-prerequisite.sh setup"))
        step = source[source.rfind("      - name:", 0, probe):source.index("      - name:", probe)]
        self.assertNotIn("continue-on-error", step)
        self.assertNotIn("sudo", step)
        self.assertNotIn("||", step)
        self.assertEqual(source.count("id: linux-namespace-setup"), 1)
        self.assertIn("if: ${{ always() && steps.linux-namespace-setup.outcome != 'skipped' }}", source)


if __name__ == "__main__":
    unittest.main()
