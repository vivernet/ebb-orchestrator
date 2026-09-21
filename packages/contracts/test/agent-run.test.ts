import { expect, expectTypeOf, test } from "vitest";

import type { RunStatus } from "../src/agent-run.js";

test("RunStatus includes the runtime completing lifecycle state", () => {
  const status: RunStatus = "COMPLETING";

  expect(status).toBe("COMPLETING");
  expectTypeOf<"COMPLETING">().toMatchTypeOf<RunStatus>();
});
