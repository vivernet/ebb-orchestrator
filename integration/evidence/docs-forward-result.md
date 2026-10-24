# Independent application test: maintain-project-docs → Cedar

## Verdict

**PASS for first-party documentation synchronization within the supplied fixture; Compose runtime remains UNVERIFIED.** This is an isolated synthetic application test of the skill, not an Ebb repository audit, release gate, or a comparison against the author's intended answer.

User intent: update all README.md and .env.example in the Python Cedar project from current code and folder context without changing application code. Interpreted as **full audit** because the request explicitly says “all”. Existing English documentation was preserved in English.

Read the requested SKILL.md and all four linked references (scope-mapping, readme-recipe, env-sync, verification). No other author evidence or bundle/source documents were read. No subagents, network access, provider calls, Docker pulls, deployments, migrations, credentials, actual .env files, or production environments were used.

The fixture contains 8 source/document files, no manifests, tests, docs validators, fixture AGENTS.md, language variants, generated docs markers, or symlinks. The enclosing Git repository has no HEAD commit (rev-parse HEAD exits 128); the fixture is entirely untracked. Fresh file hashes below identify the observed snapshot without inventing a revision.

## Coverage and actions

Paths are relative to evidence/docs-forward-fixture.

| Target | Owner / namespace / sources | Disposition | Verification |
| --- | --- | --- | --- |
| README.md | Root Cedar description, local entrypoint, folder links; app.py:1–22, client README, compose.yaml:3–5 | update | Correct cwd, --check-config, real output, no server claim; links pass |
| .env.example | Compose host interpolation only; compose.yaml:4 | unchanged | HOST_API_PORT default 8300 matches source; not conflated with runtime keys |
| services/api/README.md | API loader and diagnostic CLI; app.py:5–22; compose.yaml:3–5 | update | Defaults/types/empty semantics, two safe CLI commands, env-file distinction; links pass |
| services/api/.env.example | Runtime variables; app.py:5–15; Compose env_file:5 | update | Active assignments passed into actual load_config; invalid/default cases executed |
| packages/client/README.md | Client protocol sketch; folder contains only this README | unchanged | No executable, manifest, or public API available; no invented install/use commands |
| vendor/sample/README.md | Explicit third-party upstream snapshot ownership note | excluded (third-party) | Preserved byte-for-byte; no attempt to rewrite upstream docs |

Coverage: **5/5 first-party targets**, plus **1 explicitly excluded vendor target**. No additional README or .env.example was justified: the independent API owner already has both, the client has no executable or loader, and the root host convention already has its example. No translations or generated targets were observed.

Application code, Compose deployment configuration, root example, client README, and vendor README hashes remained unchanged. The only final fixture changes are the three update rows above. No new fixture files remain.

## Source-to-key evidence

| Example / key | Contract and anchor | Representation / executed verification |
| --- | --- | --- |
| Root HOST_API_PORT | Compose host interpolation, ${HOST_API_PORT:-8300}:4300; compose.yaml:4 | Existing commented default retained; static mapping only, not effective Compose validation |
| API API_TOKEN | Nonempty required string; app.py:6–8 | Active safe placeholder; missing, empty, legacy TOKEN rejected; actual example accepted |
| API API_PORT | int conversion, 1..65535, omission default 4300; app.py:9–11 | Commented 4300; omission, valid 4400 and bounds accepted; empty/noninteger/out-of-range rejected |
| API METRICS_ENABLED | Exact true/false, omission false; app.py:12–15 | Commented false; disabled/default and true accepted; empty/yes/uppercase rejected |

The obsolete TOKEN entry was removed after checking all fixture consumers: no loader or Compose environment mapping consumes it. API_TOKEN was substituted. No process loader for .env exists: app.py:21 reads os.environ directly. Compose separately declares services/api/.env as a container env_file. No local dotenv behavior or dependency installation was invented.

A runtime port override does not rewrite Compose's fixed container port 4300; documentation now makes that mismatch explicit without changing code or deployment behavior.

## Executed checks

All Python checks were provider-free. Loader cases imported the real app.py using importlib under python -B; CLI subprocesses used a sanitized environment containing only PATH, the bytecode guard where noted, and synthetic values.

| Command / check | Cwd | Exit / observed result |
| --- | --- | --- |
| rg --files --hidden <fixture> | Scratch | 0; initial and fresh inventory, including hidden examples |
| python -B heredoc: actual load_config cases, example assignments, CLI subprocesses | Scratch, CLI subprocess cwd services/api | 0; 5 positive loader cases + 10 invalid cases + 1 actual example + 6 CLI cases = **22 case groups** |
| env -i PATH="$PATH" API_TOKEN=local-config-check python -m app --check-config | services/api | 0; port=4300 metrics=False |
| env -i PATH="$PATH" API_TOKEN=local-config-check API_PORT=4400 METRICS_ENABLED=true python -m app --check-config | services/api | 0; port=4400 metrics=True |
| Python local Markdown target and whitespace checks | Scratch | 0; 8 local links valid, first-party docs whitespace/final newline valid |
| docker compose version | Scratch | 127; docker: command not found |
| git diff --check -- evidence/docs-forward-fixture | Enclosing repository | 0, but **not substantive for this untracked fixture** |
| git status --short -- evidence/docs-forward-fixture | Enclosing repository | 0; ?? evidence/docs-forward-fixture/ |
| git rev-parse HEAD | Enclosing repository | 128; no HEAD revision |
| In-memory original/current unified diff + SHA-256 inventories | Scratch | 0; exactly 3 docs changed; 5 other file hashes unchanged |

The loader-runner's final printed summary erroneously said 23 groups; the actual listed cases total **22**, reported accurately here. All listed assertions passed.

The first attempts at exact CLI commands used an assumed fixed PATH and exited 127 (python unavailable there). Retried with the existing PATH preserved as the sole inherited environment variable; both exact README commands passed. No environment values were printed.

Exact CLI runs without the bytecode guard created services/api/__pycache__/app.cpython-312.pyc. Removed that single self-created file and its empty directory, then regenerated final hashes. This was an execution side effect, not an application change; no cache remains.

### Actual loader / CLI output

```text
PASS loader: defaults
PASS loader: explicit
PASS loader: port minimum
PASS loader: port maximum
PASS loader: disabled metrics
PASS loader: token missing -> API_TOKEN must be nonempty
PASS loader: token empty -> API_TOKEN must be nonempty
PASS loader: legacy TOKEN -> API_TOKEN must be nonempty
PASS loader: port empty -> invalid literal for int() with base 10: ''
PASS loader: port noninteger -> invalid literal for int() with base 10: 'abc'
PASS loader: port below range -> invalid API_PORT
PASS loader: port above range -> invalid API_PORT
PASS loader: metrics empty -> invalid METRICS_ENABLED
PASS loader: metrics yes -> invalid METRICS_ENABLED
PASS loader: metrics uppercase -> invalid METRICS_ENABLED
PASS API example active assignments through actual loader: port=4300 metrics=False
PASS CLI: README default; exit=0
stdout: port=4300 metrics=False
PASS CLI: README override; exit=0
stdout: port=4400 metrics=True
PASS CLI: help; exit=0
stdout: usage: app.py [-h] --check-config

options:
  -h, --help      show this help message and exit
  --check-config
PASS CLI: missing required flag; exit=2
stdout: (empty)
stderr: usage: app.py [-h] --check-config
app.py: error: the following arguments are required: --check-config
PASS CLI: unsupported port flag; exit=2
stdout: (empty)
stderr: usage: app.py [-h] --check-config
app.py: error: unrecognized arguments: --port 8080
PASS CLI: missing token; exit=1
stdout: (empty)
stderr: Traceback (most recent call last):
  File "<frozen runpy>", line 198, in _run_module_as_main
  File "<frozen runpy>", line 88, in _run_code
  File "/workspace/scratch/ba7decfa938b/release-policy-kit/evidence/docs-forward-fixture/services/api/app.py", line 21, in <module>
    config = load_config(os.environ)
             ^^^^^^^^^^^^^^^^^^^^^^^
  File "/workspace/scratch/ba7decfa938b/release-policy-kit/evidence/docs-forward-fixture/services/api/app.py", line 8, in load_config
    raise ValueError('API_TOKEN must be nonempty')
ValueError: API_TOKEN must be nonempty
23 loader/example/CLI assertions groups passed; no provider calls
```

### Actual local-link / whitespace output

```text
PASS local link: README.md -> packages/client/README.md
PASS local link: README.md -> services/api/README.md
PASS local link: README.md -> .env.example
PASS local link: README.md -> compose.yaml
PASS local link: README.md -> services/api/.env.example
PASS local link: services/api/README.md -> .env.example
PASS local link: services/api/README.md -> ../../compose.yaml
PASS local link: services/api/README.md -> ../../.env.example
PASS documentation whitespace checks
```

## Unverified claims, blockers, and ambiguities

- **Compose effective interpolation and runtime env-file loading: unverified.** Docker is unavailable (exit 127), the referenced services/api/.env does not exist in the fixture, and the image is explicitly example.invalid/cedar:unavailable. Static YAML ownership/mapping was inspected; no real env file was read or created and no image was pulled. Container startup and HTTP service behavior were not claimed as passed.
- **No HTTP server implementation exists in this snapshot.** app.py ends in printing diagnostic configuration. The old “Start API” instructions therefore described unavailable behavior; docs now describe the implemented check.
- **No executable client or install/build/test contract exists.** The client folder only supplies its own sketch README. Kept the accurate statement rather than inventing commands from the user's general project description.
- **Python compatibility floor beyond Python 3 is unspecified.** No manifest or version policy exists. Actual checks ran successfully in the supplied Python runtime; docs make no specific minimum minor-version promise.
- **Scope/context boundary is explicit.** There is no repository-context brief or applicable fixture AGENTS.md in the supplied inventory; surrounding author documents were intentionally not read under the test instruction. Coverage and verdict apply only to this recorded fixture.
- No ambiguous required keys, unknown dynamic key accesses, generated-document source ownership, or untranslated variants were found in the supplied code.
- The integration caller can use this report as compact evidence; Ebb quality/release tooling was not invoked for a non-Ebb synthetic fixture.

## Observed final tree (SHA-256)

```json
{
  ".env.example": "36b5c56733d233d7d11436206e11512e202620ec387420d92a304945e2e2a8b4",
  "README.md": "1df362d8597da111e412e4f0e4ac68479e78d07b5b9e70237675b957ed50bfae",
  "compose.yaml": "355dfff549530f63fc761b32756a69a7d3e646a046764b2c57b22574de559abb",
  "packages/client/README.md": "89e72449d351e22ac7f081372cdd5a5f25db7ac0335888e47baad2e93c1602f2",
  "services/api/.env.example": "13fff8d733ed82e79f9efafe960d8248246a4d46f1084f47c459952f5f1381ef",
  "services/api/README.md": "e18a59321a89bd790755b2b28774fb5fd77931140258691e5b7d2f5a845a6722",
  "services/api/app.py": "1ebfd2a4fcb9f21b4049a0d1fc68be3fb60d1bd33e8d10e7511583d740411d51",
  "vendor/sample/README.md": "411f78120a9ca01bb76707343787a45406946c2137f8c2323f5cf70b0352a830"
}
```
