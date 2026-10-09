---
id: proposal-16
kind: proposal
title: Versioned Linux AppArmor attachment evidence for Plan20
status: draft
created: 2026-10-09
updated: 2026-10-09
---

# Proposal 16 — Linux AppArmor attachment evidence

> **Статус:** draft для независимого security/architecture review и решения пользователя. Это не implementation plan и не разрешение заменить текущий fail-closed gate.

## 1. Цель и границы

Разблокировать точную проверку Linux process-scope prerequisites, когда kernel AppArmor policy export содержит `/attach=<unknown>` для уже скомпилированного attachment DFA. Требуемое доказательство — что ни один foreign loaded profile не может примениться к конкретным helper/probe executable paths, которые будут использоваться текущей acceptance generation.

Существующий Linux gate остаётся fail-closed, пока новый проверенный механизм не докажет непересечение для каждого foreign profile. Fixture/mock results не являются доказательством для live kernel policy.

Вне scope: изменение существующих host ACL/permissions, изменение global AppArmor policy вне уже одобренного ephemeral acceptance setup, изменение sysctl/services/cache, удаление или перезагрузка чужих policy, игнорирование `<unknown>`, ослабление STOPPED contract, изменение Windows/macOS contracts или постоянное хранение host policy bytes.

## 2. Текущее состояние и evidence

- Hosted Production gates run `37929857217`, SHA `c587fb918d90507ae9300d336f39179d2dd5e684`: Linux prerequisite прошёл source snapshot и остановился до parser preflight/profile load с `HERMES_NAMESPACE_SETUP_POLICY_ATTACHMENT_UNKNOWN`; cleanup отказал с `HERMES_NAMESPACE_SETUP_ACCEPTANCE_NOT_COMPLETED`. Linux native acceptance не запускалась.
- Linux kernel `/attach=<unknown>` означает, что compiled xmatch DFA существует, но source attachment string не экспортируется. Оно не доказывает disjointness. Проверенная upstream semantics есть в [Linux AppArmor `apparmorfs.c`](https://github.com/torvalds/linux/blob/v6.17/security/apparmor/apparmorfs.c#L1033).
- Upstream `apparmor_parser` v4.0.1 serializes xmatch DFA, но не optional source `attach` field; therefore owned and foreign profiles can both expose unknown attachment text. Exact owned profiles still have a potential proof path from the trusted exact policy bytes/compiler through kernel `raw_sha256` and live profile identity; this does not prove foreign profile disjointness.
- `.access`/libapparmor queries inspect file/policy permissions, not `attach->xmatch`; successful helper exec or observing its selected label does not prove that every foreign xmatch is disjoint from the target paths.
- Current `ubuntu-24.04` hosted runner uses a rolling image/kernel; exact downstream AppArmor source revision and raw ABI for the failed job were not recorded. No raw policy bytes were retained.

## 3. Решения и trade-offs

### A — Preserve strict refusal and require a controlled runner

Keep rejecting every unknown foreign attachment. Run Linux acceptance only on a specifically managed image/runner whose loaded policy source/ABI has been independently proven and whose security/ownership boundary is accepted. No decoder enters production.

**Плюсы:** smallest trusted code base; no userspace reimplementation of kernel matcher.

**Минусы:** current hosted Ubuntu job remains red until a reproducible controlled runner is available; runner provisioning/maintenance becomes a separate operational dependency. Merely pinning the GitHub label does not pin the host kernel/profile inventory.

### B — Source-backed compilation certificate

Map every live `raw_sha256` to a reproducibly compiled, exact source/profile certificate and infer path disjointness from the attachment expression.

**Ограничение:** exact compiled hash only binds bytes to a compiler/source input. It does not expose a stable postprocessed attachment AST. Generated snapd/Docker sources may no longer exist; any missing source, nondeterministic compiler output, unmatched hash, unresolved include/alias/variable, or unparsed expression must remain `UNKNOWN`. Current evidence does not establish full coverage or a sound path-disjointness certificate. This approach alone is insufficient to pass the gate.

### C — Versioned, conservative xmatch evidence component (рекомендация для дальнейшего design)

Parse bounded kernel-exported raw policy data, authenticate it against each profile's `raw_sha256` and a stable namespace/revision snapshot, decode only explicitly reviewed representations, and reproduce the kernel attachment **pathname** matcher for exact target path bytes. Return one of `NO_PATH_MATCH`, `PATH_MATCH`, or `UNSUPPORTED` per profile/path.

The gate accepts an unknown foreign attachment only if every supported compiled representation returns `NO_PATH_MATCH` for every exact helper/probe path. `PATH_MATCH`, malformed/truncated data, unsupported ABI/table/flag/encoding, changed namespace revision, missing export, timeout, or resource cap returns refusal. A path match is rejected conservatively without attempting to model xattr matching or winner priority. The implementation must mirror the kernel's `aa_dfa_leftmatch` semantics, including optional equivalence classes, loop handling, diff/default transitions, and version-specific permission decoding; a regular-expression or approximate glob implementation is not acceptable.

**Плюсы:** preserves current fail-closed contract while handling compiled foreign policies without changing them or relying on their source files.

**Минусы:** introduces security-sensitive binary parsing and a userspace mirror of kernel matching semantics; requires versioned support, pinned source evidence, raw fixtures and differential tests. It can increase maintenance as Linux kernel/AppArmor formats change. Any unreviewed representation continues to block.

## 4. Recommended boundary and interface for design review

If C is selected for implementation planning, the component is a pure bounded evaluator with no filesystem writes, policy mutation, shell, network, or credential access:

```text
evaluateAttachmentEvidence(snapshot, targetPathBytes[]) -> {
  evidenceVersion,
  namespaceRevision,
  profiles: [{ rawSha256, targetResults: [NO_PATH_MATCH | PATH_MATCH | UNSUPPORTED] }]
}
```

Inputs must come from one bounded live AppArmor policy snapshot. The evaluator must authenticate profile identity and binary digest, reject duplicate/missing/raw fields and trailing data, enforce caps on profile count, bytes, DFA states/transitions, paths and total work, and pin the exact parser/feature/kernel source revisions represented by the fixture suite. Kernel/OS version text alone is not an ABI certificate. All raw policy bytes stay in memory and are never logged, persisted, or uploaded as artifacts. Output uses only digests, allowlisted classifications and bounded reason codes.

The first implementation plan must explicitly select its supported raw ABI/DFA/permission encodings based on evidence from the actual CI runner. Unknown formats always remain fail-closed; there is no fallback to names, partial source certificates, parser labels, or runtime label observations.

## 5. Feasibility evidence and conditions for acceptance

The first item below is a **pre-design feasibility prerequisite**: collect enough information to decide whether Option C has a bounded, reviewable ABI scope. It does not require implementing a decoder. The remaining items are **implementation acceptance/readiness conditions** and apply only if the user separately selects C and approves a detailed implementation plan. They are not prerequisites for approving that plan, and passing design review does not count them as completed evidence.

- **Before selecting/approving C:** capture ephemeral raw-policy fixtures for the exact hosted runner without retaining policy bytes in logs/artifacts; record only version/ABI identifiers and digests. If fixtures cannot be safely captured and reviewed, do not approve an implementation plan for C; keep the gate blocked or choose A/current refusal.
- **Before Linux production acceptance/readiness:** build an independent differential oracle from the exact reviewed kernel matcher source; compare boundary paths, UTF-8/opaque bytes policy, exact and non-matching paths, optional equivalence classes, loops, diff/default chains, legacy/indexed permissions, malformed/truncated payloads, and resource limits.
- **Before Linux production acceptance/readiness:** demonstrate hash/revision binding against the live kernel snapshot and deterministic refusal when policy changes during collection.
- **Before Linux production acceptance/readiness:** independently review parser memory/resource bounds, input trust, version dispatch, exact matcher semantics, and test vectors.
- **Before Linux production acceptance/readiness:** run provider-free hosted Linux acceptance on the pinned/reviewed supported ABI; prove child-scope STOPPED and cleanup only after STOPPED. No mocked/seeded test may substitute for the live kernel gate.
- Keep Linux native acceptance `NOT RUN` until the full runner acceptance succeeds. Never count this proposal or its parser unit fixtures as PASS.

## 6. Open decision

After the review and raw-ABI feasibility evidence, choose whether to:

1. approve the additional versioned xmatch evaluator (C) and its maintenance/security burden;
2. keep Linux support fail-closed on unknown host profiles and adopt a separately managed, specifically validated runner (A); or
3. retain the current refusal until the necessary evidence/infrastructure exists.

Do not implement C or change runner ownership until this decision and a separate detailed implementation plan are approved. No Plan20/Plan19 status is changed here.

## 7. Primary references

- Plan/spec authority: `docs/architecture/specs/01-system-design.md`; `docs/architecture/plans/20-production-context-manifest.md` Task5A-WL and Linux CI acceptance.
- Failed hosted evidence: Production gates run `37929857217`, Linux job `113817636201`, source SHA `c587fb918d90507ae9300d336f39179d2dd5e684`.
- Linux kernel v6.17 AppArmor raw matcher: [match.c](https://github.com/torvalds/linux/blob/v6.17/security/apparmor/match.c#L647), [domain.c](https://github.com/torvalds/linux/blob/v6.17/security/apparmor/domain.c#L395), [apparmorfs.c](https://github.com/torvalds/linux/blob/v6.17/security/apparmor/apparmorfs.c#L1033), [match.h](https://github.com/torvalds/linux/blob/v6.17/security/apparmor/include/match.h), [policy_compat.c](https://github.com/torvalds/linux/blob/v6.17/security/apparmor/policy_compat.c#L161).
- AppArmor parser 4.0 documentation: [apparmor_parser manual](https://apparmor.net/man/4.0/apparmor_parser/).
- Parser v4.0.1 serialization/compiler sources: [parser_interface.c](https://gitlab.com/apparmor/apparmor/-/blob/v4.0.1/parser/parser_interface.c), [parser_regex.c](https://gitlab.com/apparmor/apparmor/-/blob/v4.0.1/parser/parser_regex.c), [chfa.cc](https://gitlab.com/apparmor/apparmor/-/blob/v4.0.1/parser/libapparmor_re/chfa.cc).
