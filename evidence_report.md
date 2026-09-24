=== Quality Gates Report ===
Date: 24 сен 2026 г.  4:01:24

=== 1. git diff --check ===
apps/server/src/modules/runtime/run-service.ts:218: trailing whitespace.
+    
apps/server/src/modules/runtime/run-service.ts:227: trailing whitespace.
+    
apps/server/src/modules/runtime/run-service.ts:232: trailing whitespace.
+    
apps/server/src/modules/runtime/run-service.ts:237: trailing whitespace.
+    
apps/server/src/modules/runtime/run-service.ts:245: trailing whitespace.
+    
Exit code: 2

=== 2. pnpm typecheck ===
$ pnpm -r --if-present typecheck
packages/contracts typecheck$ tsc -p tsconfig.json --noEmit
packages/testing typecheck$ tsc -p tsconfig.json --noEmit
packages/testing typecheck: Done
packages/contracts typecheck: Done
apps/server typecheck$ tsc -p tsconfig.json --noEmit
apps/server typecheck: src/modules/runtime/run-service.ts(239,58): error TS2339: Property 'output' does not exist on type 'AgentRun'.
apps/server typecheck: test/platform/jobs/job-registry.test.ts(112,14): error TS18048: 'updated' is possibly 'undefined'.
apps/server typecheck: test/platform/jobs/job-registry.test.ts(113,14): error TS18048: 'updated' is possibly 'undefined'.
apps/server typecheck: test/platform/jobs/job-registry.test.ts(153,14): error TS18048: 'updated' is possibly 'undefined'.
apps/server typecheck: test/platform/jobs/job-registry.test.ts(165,16): error TS2352: Conversion of type 'Promise<void>' to type 'Promise<{ claimed: number; succeeded: number; failed: number; }>' may be a mistake because neither type sufficiently overlaps with the other. If this was intentional, convert the expression to 'unknown' first.
apps/server typecheck:   Type 'void' is not comparable to type '{ claimed: number; succeeded: number; failed: number; }'.
apps/server typecheck: test/platform/jobs/job-registry.test.ts(174,5): error TS2454: Variable 'resolve' is used before being assigned.
apps/server typecheck: Failed
[ELIFECYCLE] Command failed with exit code 2.
Error: ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL

  × "pnpm recursive run" failed in C:\Users\alex1\Repos\NEW\DEV\ebb-
  │ orchestrator-develop\apps\server

[ELIFECYCLE] Command failed with exit code 1.
Exit code: 1

=== 3. pnpm lint ===
$ eslint .

C:\Users\alex1\Repos\NEW\DEV\ebb-orchestrator-develop\apps\server\src\modules\execution\command-policy.ts
   2:10  error  'PathResolver' is defined but never used. Allowed unused vars must match /^_/u  @typescript-eslint/no-unused-vars
  31:8   error  Missing JSDoc comment                                                           jsdoc/require-jsdoc

C:\Users\alex1\Repos\NEW\DEV\ebb-orchestrator-develop\apps\server\src\platform\jobs\job-runner.ts
  9:3  error  'JobHandler' is defined but never used. Allowed unused vars must match /^_/u  @typescript-eslint/no-unused-vars

C:\Users\alex1\Repos\NEW\DEV\ebb-orchestrator-develop\apps\server\test\modules\execution\command-policy.test.ts
   6:10  error  'ActionGateway' is defined but never used. Allowed unused vars must match /^_/u      @typescript-eslint/no-unused-vars
  13:7   error  'resolver' is assigned a value but never used. Allowed unused vars must match /^_/u  @typescript-eslint/no-unused-vars

C:\Users\alex1\Repos\NEW\DEV\ebb-orchestrator-develop\apps\server\test\platform\jobs\job-registry.test.ts
   27:28  error  'job' is defined but never used. Allowed unused args must match /^_/u  @typescript-eslint/no-unused-vars
   27:33  error  Unexpected any. Specify a different type                               @typescript-eslint/no-explicit-any
   33:28  error  'job' is defined but never used. Allowed unused args must match /^_/u  @typescript-eslint/no-unused-vars
   33:33  error  Unexpected any. Specify a different type                               @typescript-eslint/no-explicit-any
   39:28  error  'job' is defined but never used. Allowed unused args must match /^_/u  @typescript-eslint/no-unused-vars
   39:33  error  Unexpected any. Specify a different type                               @typescript-eslint/no-explicit-any
   46:28  error  'job' is defined but never used. Allowed unused args must match /^_/u  @typescript-eslint/no-unused-vars
   46:33  error  Unexpected any. Specify a different type                               @typescript-eslint/no-explicit-any
   56:39  error  'job' is defined but never used. Allowed unused args must match /^_/u  @typescript-eslint/no-unused-vars
   56:44  error  Unexpected any. Specify a different type                               @typescript-eslint/no-explicit-any
   57:39  error  'job' is defined but never used. Allowed unused args must match /^_/u  @typescript-eslint/no-unused-vars
   57:44  error  Unexpected any. Specify a different type                               @typescript-eslint/no-explicit-any
   62:39  error  'job' is defined but never used. Allowed unused args must match /^_/u  @typescript-eslint/no-unused-vars
   62:44  error  Unexpected any. Specify a different type                               @typescript-eslint/no-explicit-any
   63:39  error  'job' is defined but never used. Allowed unused args must match /^_/u  @typescript-eslint/no-unused-vars
   63:44  error  Unexpected any. Specify a different type                               @typescript-eslint/no-explicit-any
  118:28  error  'job' is defined but never used. Allowed unused args must match /^_/u  @typescript-eslint/no-unused-vars
  118:33  error  Unexpected any. Specify a different type                               @typescript-eslint/no-explicit-any

C:\Users\alex1\Repos\NEW\DEV\ebb-orchestrator-develop\scripts\run-server.js
  14:2  error  Parsing error: ',' expected

✖ 24 problems (24 errors, 0 warnings)
  1 error and 0 warnings potentially fixable with the `--fix` option.

[ELIFECYCLE] Command failed with exit code 1.
Exit code: 1

=== 4. pnpm build ===
$ pnpm -r --if-present build
packages/contracts prebuild$ node scripts/clean-dist.mjs
packages/contracts prebuild: Done
packages/contracts build$ tsc -p tsconfig.build.json
packages/contracts build: Done
apps/web build$ tsc -b && vite build
apps/server prebuild$ node scripts/clean-dist.mjs
apps/server prebuild: Done
apps/server build$ pnpm --filter @ebb-orchestrator/contracts build && tsc -p tsconfig.build.json && node scripts/build.mjs
apps/server build: $ node scripts/clean-dist.mjs
apps/server build: $ tsc -p tsconfig.build.json
apps/server build: src/modules/runtime/run-service.ts(239,58): error TS2339: Property 'output' does not exist on type 'AgentRun'.
apps/server build: Failed
[ELIFECYCLE] Command failed with exit code 2.
apps/web build: Failed
[ELIFECYCLE] Command failed with exit code 1.
Error: ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL

  × "pnpm recursive run" failed in C:\Users\alex1\Repos\NEW\DEV\ebb-
  │ orchestrator-develop\apps\server

[ELIFECYCLE] Command failed with exit code 1.
Exit code: 1

=== 5. pnpm test ===
$ pnpm -r --if-present test
Scope: 4 of 5 workspace projects
packages/testing test$ vitest run --passWithNoTests
packages/contracts test$ vitest run --passWithNoTests
packages/contracts test: 
packages/contracts test:  RUN  v5.0.0 C:/Users/alex1/Repos/NEW/DEV/ebb-orchestrator-develop/packages/contracts
packages/contracts test: 
packages/testing test: 
packages/testing test:  RUN  v5.0.0 C:/Users/alex1/Repos/NEW/DEV/ebb-orchestrator-develop/packages/testing
packages/testing test: 
packages/testing test: No test files found, exiting with code 0
packages/testing test: 
packages/testing test: include: **/*.{test,spec}.?(c|m)[jt]s?(x)
packages/testing test: exclude:  **/node_modules/**, **/.git/**
packages/testing test: 
packages/testing test: Done
packages/contracts test: 
packages/contracts test:  Test Files  2 passed (2)
packages/contracts test:       Tests  3 passed (3)
packages/contracts test:    Start at  04:03:02
packages/contracts test:    Duration  462ms (transform 49%, import 36%, worker 9%, tests 6%)
packages/contracts test: 
packages/contracts test: Done
apps/web test$ vitest run
apps/server test$ vitest run
apps/server test: 
apps/server test:  RUN  v5.0.0 C:/Users/alex1/Repos/NEW/DEV/ebb-orchestrator-develop/apps/server
apps/server test: 
apps/web test: 
apps/web test:  RUN  v5.0.0 C:/Users/alex1/Repos/NEW/DEV/ebb-orchestrator-develop/apps/web
apps/web test: 
apps/server test:  ❯ test/e2e/transport-origin.test.ts (2 tests | 1 failed) 1273ms
apps/server test:    ❯ real HTTP transport origin contract (2)
apps/server test:      × uses the canonical loopback hostname in the generated launch link 37ms
apps/server test: stderr | test/modules/execution/mcp/mcp-server.test.ts > MCP Server > submit_result lifecycle > should block second submit_result call
apps/server test: [MCP test-capability] Internal error: RUN_ALREADY_COMPLETING
apps/server test: 
apps/server test: stderr | test/modules/execution/mcp/mcp-server.test.ts > MCP Server > submit_result lifecycle > should block write-capable tools after submit_result
apps/server test: [MCP test-capability] Internal error: RUN_ALREADY_COMPLETING
apps/server test: 
apps/server test: stderr | test/modules/execution/mcp/mcp-server.test.ts > MCP Server > security > accepts only the issued run reference and atomically rejects duplicates
apps/server test: [MCP run-1] Internal error: RUN_ALREADY_COMPLETING
apps/server test: 
apps/server test:  ❯ test/modules/execution/mcp/mcp-server.test.ts (19 tests | 3 failed) 5777ms
apps/server test:    ❯ MCP Server (19)
apps/server test:      ❯ submit_result lifecycle (4)
apps/server test:        × should block second submit_result call 15ms
apps/server test:        × should block write-capable tools after submit_result 14ms
apps/server test:      ❯ security (3)
apps/server test:        × accepts only the issued run reference and atomically rejects duplicates 10ms
apps/server test: Switched to a new branch 'main'
apps/server test: Switched to a new branch 'main'
apps/server test: Switched to a new branch 'master'
apps/web test: 
apps/web test:  Test Files  13 passed (13)
apps/web test:       Tests  148 passed (148)
apps/web test:    Start at  04:03:03
apps/web test:    Duration  32.46s (environment 58%, tests 16%, setup 15%, import 7%, transform 4%)
apps/web test: 
apps/web test: Environment  jsdom was created 13 times · 47.03s total, 58% of tracked time
apps/web test:              create it once per worker with pool: 'vmThreads' (keeps per-file isolation) or isolate: false (shares it across files)
apps/web test:              learn more: https://vitest.dev/guide/improving-performance#test-environments
apps/web test: 
apps/web test: Done
apps/server test: 
apps/server test: ⎯⎯⎯⎯⎯⎯⎯ Failed Tests 4 ⎯⎯⎯⎯⎯⎯⎯
apps/server test: 
apps/server test:  FAIL  test/e2e/transport-origin.test.ts > real HTTP transport origin contract > uses the canonical loopback hostname in the generated launch link
apps/server test: AssertionError: expected '<!DOCTYPE html>\n<html>\n<head>\n    …' to contain 'http://127.0.0.1:3000/#ebb-bootstrap='
apps/server test: 
apps/server test: [32m- Expected[39m
apps/server test: [31m+ Received[39m
apps/server test: 
apps/server test: [32m- http://127.0.0.1:3000/#ebb-bootstrap=[39m
apps/server test: [31m+ <!DOCTYPE html>[39m
apps/server test: [31m+ <html>[39m
apps/server test: [31m+ <head>[39m
apps/server test: [31m+     <meta charset="UTF-8">[39m
apps/server test: [31m+     <title>Ebb Orchestrator - Получить ссылку</title>[39m
apps/server test: [31m+     <style>[39m
apps/server test: [31m+         body { font-family: system-ui; padding: 20px; }[39m
apps/server test: [31m+         .step { margin: 15px 0; padding: 15px; background: #f5f5f5; border-radius: 5px; }[39m
apps/server test: [31m+         input { width: 100%; padding: 8px; font-family: monospace; }[39m
apps/server test: [31m+         button { padding: 10px 20px; cursor: pointer; }[39m
apps/server test: [31m+         .success { background: #d4edda; }[39m
apps/server test: [31m+     </style>[39m
apps/server test: [31m+ </head>[39m
apps/server test: [31m+ <body>[39m
apps/server test: [31m+     <h1>Ebb Orchestrator</h1>[39m
apps/server test: [31m+     [39m
apps/server test: [31m+     <div class="step">[39m
apps/server test: [31m+         <strong>Шаг 1:</strong> В терминале введи:[39m
apps/server test: [31m+         <br><code>pnpm start</code>[39m
apps/server test: [31m+     </div>[39m
apps/server test: [31m+     [39m
apps/server test: [31m+     <div class="step">[39m
apps/server test: [31m+         <strong>Шаг 2:</strong> Когда сервер запустится, скопируй токен из файла:[39m
apps/server test: [31m+         <br><input type="text" id="token" placeholder="Вставь bootstrapToken здесь">[39m
apps/server test: [31m+     </div>[39m
apps/server test: [31m+     [39m
apps/server test: [31m+     <div class="step">[39m
apps/server test: [31m+         <button onclick="generateLink()">Создать ссылку</button>[39m
apps/server test: [31m+     </div>[39m
apps/server test: [31m+     [39m
apps/server test: [31m+     <div class="step success" id="result" style="display:none">[39m
apps/server test: [31m+         <strong>Открой эту ссылку:</strong>[39m
apps/server test: [31m+         <br><input type="text" id="link">[39m
apps/server test: [31m+     </div>[39m
apps/server test: [31m+     [39m
apps/server test: [31m+     <script>[39m
apps/server test: [31m+         function generateLink() {[39m
apps/server test: [31m+             const token = document.getElementById('token').value.trim();[39m
apps/server test: [31m+             if (!token) {[39m
apps/server test: [31m+                 alert('Вставь токен');[39m
apps/server test: [31m+                 return;[39m
apps/server test: [31m+             }[39m
apps/server test: [31m+             const link = 'http://localhost:3000/#ebb-bootstrap=' + encodeURIComponent(token);[39m
apps/server test: [31m+             document.getElementById('link').value = link;[39m
apps/server test: [31m+             document.getElementById('result').style.display = 'block';[39m
apps/server test: [31m+         }[39m
apps/server test: [31m+     </script>[39m
apps/server test: [31m+ </body>[39m
apps/server test: [31m+ </html>[39m
apps/server test: [31m+[39m
apps/server test: 
apps/server test:  ❯ test/e2e/transport-origin.test.ts:46:22
apps/server test:      44|   it("uses the canonical loopback hostname in the generated launch lin…
apps/server test:      45|     const launcher = readFileSync(resolve(migrationDir, "../../../../.…
apps/server test:      46|     expect(launcher).toContain("http://127.0.0.1:3000/#ebb-bootstrap="…
apps/server test:        |                      ^
apps/server test:      47|     expect(launcher).not.toContain("http://localhost:3000/#ebb-bootstr…
apps/server test:      48|   });
apps/server test: 
apps/server test: ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/4]⎯
apps/server test: 
apps/server test:  FAIL  test/modules/execution/mcp/mcp-server.test.ts > MCP Server > submit_result lifecycle > should block second submit_result call
apps/server test: AssertionError: expected 'Tool calls are not allowed after subm…' to contain 'RUN_ALREADY_COMPLETING'
apps/server test: 
apps/server test: Expected: [32m"RUN_ALREADY_COMPLETING"[39m
apps/server test: Received: [31m"Tool calls are not allowed after submit_result has been called"[39m
apps/server test: 
apps/server test:  ❯ test/modules/execution/mcp/mcp-server.test.ts:322:34
apps/server test:     320|
apps/server test:     321|       expect(secondResult.success).toBe(false);
apps/server test:     322|       expect(secondResult.error).toContain('RUN_ALREADY_COMPLETING');
apps/server test:        |                                  ^
apps/server test:     323|     });
apps/server test:     324|
apps/server test: 
apps/server test: ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/4]⎯
apps/server test: 
apps/server test:  FAIL  test/modules/execution/mcp/mcp-server.test.ts > MCP Server > submit_result lifecycle > should block write-capable tools after submit_result
apps/server test: AssertionError: expected 'Tool calls are not allowed after subm…' to contain 'RUN_ALREADY_COMPLETING'
apps/server test: 
apps/server test: Expected: [32m"RUN_ALREADY_COMPLETING"[39m
apps/server test: Received: [31m"Tool calls are not allowed after submit_result has been called"[39m
apps/server test: 
apps/server test:  ❯ test/modules/execution/mcp/mcp-server.test.ts:391:33
apps/server test:     389|
apps/server test:     390|       expect(patchResult.success).toBe(false);
apps/server test:     391|       expect(patchResult.error).toContain('RUN_ALREADY_COMPLETING');
apps/server test:        |                                 ^
apps/server test:     392|     });
apps/server test:     393|   });
apps/server test: 
apps/server test: ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[3/4]⎯
apps/server test: 
apps/server test:  FAIL  test/modules/execution/mcp/mcp-server.test.ts > MCP Server > security > accepts only the issued run reference and atomically rejects duplicates
apps/server test: AssertionError: expected 'Tool calls are not allowed after subm…' to contain 'RUN_ALREADY_COMPLETING'
apps/server test: 
apps/server test: Expected: [32m"RUN_ALREADY_COMPLETING"[39m
apps/server test: Received: [31m"Tool calls are not allowed after submit_result has been called"[39m
apps/server test: 
apps/server test:  ❯ test/modules/execution/mcp/mcp-server.test.ts:409:112
apps/server test: 
apps/server test: 
apps/server test: ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[4/4]⎯
apps/server test: 
apps/server test: 
apps/server test:  Test Files  2 failed | 75 passed (77)
apps/server test:       Tests  4 failed | 717 passed | 2 skipped (723)
apps/server test:    Start at  04:03:03
apps/server test:    Duration  55.75s (tests 89%, transform 4%, import 4%, worker 2%)
apps/server test: 
apps/server test: Failed
[ELIFECYCLE] Test failed. See above for more details.
Error: ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL

  × "pnpm recursive run" failed in C:\Users\alex1\Repos\NEW\DEV\ebb-
  │ orchestrator-develop\apps\server

[ELIFECYCLE] Test failed. See above for more details.
Exit code: 1
