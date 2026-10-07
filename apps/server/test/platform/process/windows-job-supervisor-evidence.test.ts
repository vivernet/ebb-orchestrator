import { describe, expect, it } from "vitest";
import { WindowsPathChainEvidenceParser, WINDOWS_PATH_CHAIN_EVIDENCE_STAGES } from "../../../src/platform/process/windows-job-supervisor.js";

const binding = {
  containmentId: "a".repeat(64),
  runId: "run-123",
  launchNonce: "b".repeat(64),
  expectedDigests: Object.fromEntries(WINDOWS_PATH_CHAIN_EVIDENCE_STAGES.map((stage, index) => [stage, String(index + 1).repeat(64)])) as Record<(typeof WINDOWS_PATH_CHAIN_EVIDENCE_STAGES)[number], string>,
};

function line(stage: string, digest: string, values = binding): string {
  return `EBB_EVIDENCE\tV1\t${stage}\t${values.containmentId}\t${values.runId}\t${values.launchNonce}\t${digest}\n`;
}

function records(values = binding): string {
  return WINDOWS_PATH_CHAIN_EVIDENCE_STAGES.map((stage, index) => line(stage, String(index + 1).repeat(64), values)).join("");
}

function envelope(body: string): string {
  return `${body}EBB_EVIDENCE_END_V1:${Buffer.byteLength(body).toString(16).padStart(8, "0")}`;
}

describe("bounded Windows native path-chain evidence framing", () => {
  it("accepts split byte writes and returns only the payload prefix", () => {
    const parser = new WindowsPathChainEvidenceParser(binding);
    const bytes = Buffer.from(`done${envelope(records())}`, "utf8");
    for (let offset = 0; offset < bytes.length;) {
      const length = Math.min((offset % 7) + 1, bytes.length - offset);
      parser.write(bytes.subarray(offset, offset + length));
      offset += length;
    }
    const result = parser.finish();
    expect(result.payloadOutput).toBe("done");
    expect(result.records.map((record) => record.stage)).toEqual(WINDOWS_PATH_CHAIN_EVIDENCE_STAGES);
  });

  it.each([
    ["lookalike payload", `EBB_EVIDENCEISH\tV1\t${envelope(records())}`],
    ["spoofed evidence in payload", `EBB_EVIDENCE\tV1\t${WINDOWS_PATH_CHAIN_EVIDENCE_STAGES[0]}\t${"a".repeat(64)}\t${binding.runId}\t${binding.launchNonce}\t${"1".repeat(64)}\n${envelope(records())}`],
    ["duplicate", envelope(`${line(WINDOWS_PATH_CHAIN_EVIDENCE_STAGES[0]!, "1".repeat(64))}${records()}`)],
    ["out of order", envelope(`${line(WINDOWS_PATH_CHAIN_EVIDENCE_STAGES[1]!, "2".repeat(64))}${records()}`)],
    ["unknown stage", envelope(`${line("OTHER", "1".repeat(64))}${records()}`)],
    ["wrong owner binding", envelope(`${line(WINDOWS_PATH_CHAIN_EVIDENCE_STAGES[0]!, "1".repeat(64), { ...binding, containmentId: "c".repeat(64) })}${records()}`)],
    ["wrong commitment", envelope(`${line(WINDOWS_PATH_CHAIN_EVIDENCE_STAGES[0]!, "f".repeat(64))}${records().split("\n").slice(1).join("\n")}`)],
    ["oversized record", envelope(`EBB_EVIDENCE\t${"x".repeat(600)}\n${records()}`)],
    ["unknown version", envelope(`EBB_EVIDENCE\tV2\t${records()}`)],
  ])("rejects %s", (_name, input) => {
    const parser = new WindowsPathChainEvidenceParser(binding);
    parser.write(Buffer.from(input, "utf8"));
    expect(() => parser.finish()).toThrow();
  });

  it("rejects missing, malformed, and trailing records", () => {
    const missing = new WindowsPathChainEvidenceParser(binding);
    const missingLines = records().split("\n").slice(0, -2).join("\n") + "\n";
    missing.write(Buffer.from(envelope(missingLines)));
    expect(() => missing.finish()).toThrow();

    const malformed = new WindowsPathChainEvidenceParser(binding);
    malformed.write(Buffer.from(envelope(`EBB_EVIDENCE\tV1\t${WINDOWS_PATH_CHAIN_EVIDENCE_STAGES[0]}\tshort\n`)));
    expect(() => malformed.finish()).toThrow();

    const trailing = new WindowsPathChainEvidenceParser(binding);
    trailing.write(Buffer.from(`${envelope(records())}payload`));
    expect(() => trailing.finish()).toThrow();
  });
});
