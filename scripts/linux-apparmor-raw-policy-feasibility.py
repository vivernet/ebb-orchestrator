"""Read-only F0: metadata diagnostics, затем отказ до review source/export ABI.

Package source/version — идентификатор установленного пакета, не доказательство
точной downstream source revision. Здесь нет поддержанного raw-export контракта,
поэтому policy namespace/inventory/raw bytes не читаются и feasibility PASS
невозможен. Вывод содержит только фиксированную схему и проверенные идентификаторы.
"""

import json
import os
import platform
import re
import selectors
import stat
import subprocess
import time

METADATA_PATHS = (
    "/sys/module/apparmor/parameters/enabled",
    "/sys/module/apparmor/parameters/export_binary",
)
# Диагностические caps для двух boolean module parameters и двух package rows.
# Они не задают будущие ограничения evaluator/parser.
METADATA_CAP = 4096
COMMAND_TIMEOUT_SECONDS = 5
UNAVAILABLE = "UNAVAILABLE"


def identifier(value, grammar, limit=128):
    """Возвращает один allowlisted identifier; ошибки/чужой текст не отражаются."""
    if isinstance(value, str) and len(value) <= limit and re.fullmatch(grammar, value, flags=re.ASCII):
        return value
    return UNAVAILABLE


def read_module_metadata(path):
    """Читает fixed module boolean через удерживаемую nofollow цепочку handles.

    Любая ошибка/подмена/cap означает отсутствие metadata. Запись, перечисление
    каталога, чтение policy/root inventory и path-based fallback отсутствуют.
    """
    if path not in METADATA_PATHS or not all(hasattr(os, name) for name in ("O_NOFOLLOW", "O_DIRECTORY", "O_CLOEXEC", "O_NONBLOCK")):
        return None
    descriptors = []
    try:
        directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
        descriptors.append(os.open("/", directory_flags))
        parts = path.strip("/").split("/")
        for component in parts[:-1]:
            descriptors.append(os.open(component, directory_flags, dir_fd=descriptors[-1]))
        descriptors.append(os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, dir_fd=descriptors[-1]))
        before = os.fstat(descriptors[-1])
        if not stat.S_ISREG(before.st_mode):
            return None
        payload = bytearray()
        deadline = time.monotonic() + 1
        while len(payload) <= METADATA_CAP and time.monotonic() < deadline:
            chunk = os.read(descriptors[-1], METADATA_CAP + 1 - len(payload))
            if not chunk:
                after = os.fstat(descriptors[-1])
                if (before.st_dev, before.st_ino, before.st_mode) != (after.st_dev, after.st_ino, after.st_mode):
                    return None
                return bytes(payload)
            payload.extend(chunk)
        return None
    except (OSError, ValueError):
        return None
    finally:
        for descriptor in reversed(descriptors):
            try:
                os.close(descriptor)
            except OSError:
                pass


def bounded_package_query(arguments):
    """Запрашивает dpkg metadata без shell, с byte/time caps и подавленным stderr.

    Partial package output при exit 1 допустим только как diagnostics для
    присутствующих exact requested packages; оно никогда не разрешает raw read.
    """
    process = None
    try:
        process = subprocess.Popen(arguments, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, shell=False, cwd="/",
                                   env={"PATH": "/usr/bin:/bin", "LC_ALL": "C"}, close_fds=True)
        deadline = time.monotonic() + COMMAND_TIMEOUT_SECONDS
        payload = bytearray()
        with selectors.DefaultSelector() as selector:
            os.set_blocking(process.stdout.fileno(), False)
            selector.register(process.stdout, selectors.EVENT_READ)
            while time.monotonic() < deadline:
                events = selector.select(max(0, deadline - time.monotonic()))
                if not events:
                    return None
                chunk = os.read(process.stdout.fileno(), METADATA_CAP + 1 - len(payload))
                if not chunk:
                    status = process.wait(timeout=max(0.001, deadline - time.monotonic()))
                    return bytes(payload) if status in (0, 1) else None
                payload.extend(chunk)
                if len(payload) > METADATA_CAP:
                    return None
        return None
    except (OSError, ValueError, subprocess.SubprocessError):
        return None
    finally:
        if process is not None:
            if process.poll() is None:
                process.kill()
            process.wait()
            if process.stdout is not None:
                process.stdout.close()


def safe_read(reader, path):
    try:
        value = reader(path)
        return value if isinstance(value, bytes) and len(value) <= METADATA_CAP else None
    except Exception:
        # Переданные test adapters и metadata failures никогда не попадают в log.
        return None


def boolean_parameter(value):
    if value in (b"Y\n", b"Y", b"1\n", b"1"):
        return "ENABLED"
    if value in (b"N\n", b"N", b"0\n", b"0"):
        return "DISABLED"
    return UNAVAILABLE


def package_metadata(payload, requested):
    """Разбирает лишь два bounded dpkg metadata rows; не AppArmor ABI/policy."""
    if not isinstance(payload, bytes) or len(payload) > METADATA_CAP:
        return {}
    try:
        rows = payload.decode("ascii").splitlines()
    except UnicodeError:
        return {}
    if len(rows) > 2:
        return {}
    result = {}
    for row in rows:
        fields = row.split("\t")
        if len(fields) != 4 or fields[0] not in requested or fields[0] in result:
            return {}
        package, version, source, source_version = fields
        if identifier(package, r"[a-z0-9][a-z0-9.+-]*") == UNAVAILABLE:
            return {}
        if any(identifier(value, r"[a-zA-Z0-9][a-zA-Z0-9.+:~_-]*") == UNAVAILABLE for value in (version, source, source_version)):
            return {}
        result[package] = (version, source, source_version)
    return result


def collect_metadata(system, release, environment, reader, command):
    """Собирает bounded diagnostics; любое metadata outcome остаётся refusal."""
    base = {"schemaVersion": 1, "result": "F0_PLATFORM_UNSUPPORTED", "rawPolicyRead": "NOT_ATTEMPTED"}
    if system != "Linux":
        return base
    base.update({
        "result": "F0_SOURCE_EXPORT_CONTRACT_UNREVIEWED",
        "runnerImage": identifier(environment.get("ImageOS"), r"ubuntu[0-9]{2}"),
        "runnerImageRevision": identifier(environment.get("ImageVersion"), r"[0-9]+(?:\.[0-9]+){1,3}"),
        "kernelRelease": identifier(release, r"[0-9]+\.[0-9]+\.[0-9]+(?:[-.][a-zA-Z0-9]+)*"),
        "kernelPackageVersion": UNAVAILABLE,
        "kernelPackageSource": UNAVAILABLE,
        "kernelPackageSourceVersion": UNAVAILABLE,
        "apparmorParserPackageVersion": UNAVAILABLE,
        "apparmorParserPackageSourceVersion": UNAVAILABLE,
        "apparmorParserExecutableVersion": "NOT_QUERIED",
        "exactKernelSourceRevision": UNAVAILABLE,
        "exactParserSourceRevision": UNAVAILABLE,
        "rawExportContract": "UNREVIEWED",
        "rawAbi": UNAVAILABLE,
        "hashBinding": UNAVAILABLE,
        "exportProfileMapping": UNAVAILABLE,
        "stablePolicyRevision": UNAVAILABLE,
        "apparmorEnablement": boolean_parameter(safe_read(reader, METADATA_PATHS[0])),
        "binaryPolicyExport": boolean_parameter(safe_read(reader, METADATA_PATHS[1])),
    })
    requested = ["apparmor"]
    if base["kernelRelease"] != UNAVAILABLE:
        requested.insert(0, "linux-image-" + base["kernelRelease"])
    arguments = ["/usr/bin/dpkg-query", "-W", "-f=${binary:Package}\t${Version}\t${source:Package}\t${source:Version}\n", *requested]
    try:
        packages = package_metadata(command(arguments), requested)
    except Exception:
        packages = {}
    kernel = packages.get("linux-image-" + base["kernelRelease"])
    if kernel:
        base["kernelPackageVersion"], base["kernelPackageSource"], base["kernelPackageSourceVersion"] = kernel
    parser = packages.get("apparmor")
    if parser:
        base["apparmorParserPackageVersion"] = parser[0]
        base["apparmorParserPackageSourceVersion"] = parser[2]
    return base


def main():
    """Один JSON diagnostic и nonzero exit; без persistent output/fallback."""
    try:
        report = collect_metadata(platform.system(), platform.release(), os.environ,
                                  read_module_metadata, bounded_package_query)
    except Exception:
        report = {"schemaVersion": 1, "result": "F0_METADATA_UNAVAILABLE", "rawPolicyRead": "NOT_ATTEMPTED"}
    print(json.dumps(report, sort_keys=True, separators=(",", ":")))
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
