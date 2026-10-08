import { describe, expect, it } from "vitest";
import {
  isWindowsNativeReadCreationTimeout,
  windowsNativeScopeCommandTimeoutMs,
} from "./windows-native-scope-timeout.js";

describe("Windows native scope diagnostic timeout", () => {
  it("extends only read-creation and recognizes its matching timeout diagnostic", () => {
    expect(windowsNativeScopeCommandTimeoutMs("read-creation")).toBe(60_000);
    expect(windowsNativeScopeCommandTimeoutMs("probe-cpu")).toBe(15_000);
    expect(windowsNativeScopeCommandTimeoutMs("is-job-member")).toBe(15_000);
    expect(windowsNativeScopeCommandTimeoutMs("terminate-exact")).toBe(15_000);

    expect(isWindowsNativeReadCreationTimeout(new Error(
      "WINDOWS_NATIVE_SCOPE_COMMAND_FAILED mode=read-creation pid=42 timeoutMs=60000 elapsedMs=60003: Process timed out after 60000ms",
    ))).toBe(true);
    expect(isWindowsNativeReadCreationTimeout(new Error(
      "WINDOWS_NATIVE_SCOPE_COMMAND_FAILED mode=read-creation pid=42 timeoutMs=15000 elapsedMs=15003: Process timed out after 15000ms",
    ))).toBe(false);
    expect(isWindowsNativeReadCreationTimeout(new Error(
      "WINDOWS_NATIVE_SCOPE_COMMAND_FAILED mode=probe-cpu pid=42 timeoutMs=15000 elapsedMs=15003: Process timed out after 15000ms",
    ))).toBe(false);
  });
});
