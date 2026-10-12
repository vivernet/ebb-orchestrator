"""Exercise real pinned Hermes registration without a provider or personal Hermes files."""

import contextlib
import io
import json
import os
from pathlib import Path
import sys

source, dependencies, fixture, home, mode = sys.argv[1:]
sys.dont_write_bytecode = True
os.environ["HERMES_HOME"] = home
os.environ["HOME"] = home
os.environ["USERPROFILE"] = home
os.environ.pop("HERMES_CONFIG", None)
sys.path[:0] = [source, dependencies]
if os.name == "nt":
    # pywin32's data-only .pth paths are required by the installed MCP SDK under -S.
    sys.path.extend(str(Path(dependencies) / suffix) for suffix in ("win32", "win32/lib", "Pythonwin"))
    dll_directory = os.add_dll_directory(str(Path(dependencies) / "pywin32_system32"))

def protect_personal_files(event, args):
    if event == "open" and isinstance(args[0], (str, bytes)):
        candidate = Path(os.fsdecode(args[0])).resolve()
        if candidate.name in (".env", "auth.json", "config.yaml") and not candidate.is_relative_to(Path(home).resolve()):
            raise RuntimeError("PERSONAL_HERMES_FILE_ACCESS_FORBIDDEN")
    if event == "socket.connect" and (not isinstance(args[1], tuple) or args[1][0] not in ("127.0.0.1", "::1")):
        raise RuntimeError("PROVIDER_NETWORK_FORBIDDEN")

sys.addaudithook(protect_personal_files)

root = Path(home)
profile = root / "profiles" / "selected"
profile.mkdir(parents=True, exist_ok=True)
(root / "active_profile").write_text("selected", encoding="utf-8")
configuration = "model:\n  provider: synthetic-provider\n  default: synthetic-model\n"
(profile / "config.yaml").write_text(configuration, encoding="utf-8")
sys.argv = ["hermes", "chat", "--help"]
from hermes_cli.main import main as hermes_main
assert Path(os.environ["HERMES_HOME"]).resolve() == profile.resolve(), "HERMES_ACTIVE_PROFILE_CHANGED"

from tools.mcp_tool_discovery import discover_mcp_tools, register_mcp_servers
from tools.mcp_tool_lifecycle import shutdown_mcp_servers
from tools.registry import registry
from toolsets import resolve_toolset, validate_toolset

try:
    if mode == "register":
        registered = register_mcp_servers({"ebb-orchestrator": {
            "command": sys.executable, "args": ["-I", "-B", fixture],
            "trust": "full", "lazy": False,
            "tools": {"resources": False, "prompts": False},
        }})
    else:
        registered = []
    expected = "mcp__ebb_orchestrator__submit_result"
    assert expected in registered, "EBB_MCP_REGISTRATION_MISSING"
    assert validate_toolset("mcp-ebb-orchestrator"), "EBB_MCP_TOOLSET_MISSING"
    assert resolve_toolset("mcp-ebb-orchestrator") == [expected], "EBB_MCP_TOOLSET_SCOPE_INVALID"
    with contextlib.redirect_stdout(io.StringIO()):
        try:
            hermes_main()
        except SystemExit as exit_signal:
            assert exit_signal.code in (None, 0), "HERMES_MAIN_STARTUP_FAILED"
    assert Path(os.environ["HERMES_HOME"]).resolve() == profile.resolve(), "HERMES_ACTIVE_PROFILE_CHANGED"
    # CLI startup discovery must preserve the already registered in-memory connection
    # even though no MCP configuration was written to the fixture profile.
    discover_mcp_tools(allowed_mcp_names=["mcp-ebb-orchestrator"])
    assert registry.get_tool_names_for_toolset("mcp-ebb-orchestrator") == [expected]
    value = registry.dispatch(expected, {})
    result = json.loads(value) if isinstance(value, str) else value
    assert json.loads(result["result"])["outcome"] == "FIXTURE_OK", "EBB_MCP_CALL_FAILED"
    assert (profile / "config.yaml").read_text(encoding="utf-8") == configuration, "EBB_MCP_CONFIG_WAS_WRITTEN"
    assert not (Path(home) / "auth.json").exists(), "EBB_MCP_AUTH_WAS_WRITTEN"
    print("HERMES_IN_MEMORY_MCP_OK", flush=True)
finally:
    shutdown_mcp_servers(timeout=5)
