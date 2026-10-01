const DETACHED_LEDGER_ERROR_MARKER = "EBB_E2E_DETACHED_LEDGER_ERROR";

export function createDetachedLedgerErrorDetector(onDetected) {
  let suffix = "";
  let detected = false;

  return (chunk) => {
    if (detected) return true;

    const combined = suffix + chunk.toString("utf8");
    detected = combined.includes(DETACHED_LEDGER_ERROR_MARKER);
    suffix = combined.slice(-(DETACHED_LEDGER_ERROR_MARKER.length - 1));
    if (detected) onDetected();
    return detected;
  };
}
