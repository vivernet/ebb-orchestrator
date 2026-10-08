type WindowsNativeScopeMode = "is-job-member" | "probe-cpu" | "read-creation" | "terminate-exact";

/** Returns the bounded timeout for a test-only Windows native-scope diagnostic command. */
export function windowsNativeScopeCommandTimeoutMs(mode: WindowsNativeScopeMode): number {
  return mode === "read-creation" ? 60_000 : 15_000;
}

/** Matches only a read-creation command that exceeded its extended diagnostic bound. */
export function isWindowsNativeReadCreationTimeout(error: unknown): error is Error {
  return error instanceof Error
    && error.message.startsWith("WINDOWS_NATIVE_SCOPE_COMMAND_FAILED mode=read-creation ")
    && error.message.includes("timeoutMs=60000 ")
    && error.message.includes(": Process timed out after 60000ms");
}
