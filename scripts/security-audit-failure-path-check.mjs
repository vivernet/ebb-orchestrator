import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const scenarios = {
  'upstream-failure': {
    outcomes: {
      INSTALL_OUTCOME: 'success',
      UPSTREAM_GATE_OUTCOME: 'failure',
      AUDIT_INJECTION_OUTCOME: 'skipped',
      AUDIT_OUTCOME: 'success',
      UPLOAD_OUTCOME: 'success',
      FINAL_GATE_OUTCOME: 'skipped',
    },
    auditExitCode: 0,
  },
  'audit-failure': {
    outcomes: {
      INSTALL_OUTCOME: 'success',
      UPSTREAM_GATE_OUTCOME: 'skipped',
      AUDIT_INJECTION_OUTCOME: 'success',
      AUDIT_OUTCOME: 'failure',
      UPLOAD_OUTCOME: 'success',
      FINAL_GATE_OUTCOME: 'failure',
    },
    auditExitCode: 1,
  },
  'install-failure': {
    outcomes: {
      INSTALL_OUTCOME: 'failure',
      UPSTREAM_GATE_OUTCOME: 'skipped',
      AUDIT_INJECTION_OUTCOME: 'skipped',
      AUDIT_OUTCOME: 'skipped',
      UPLOAD_OUTCOME: 'skipped',
      FINAL_GATE_OUTCOME: 'skipped',
    },
    auditExitCode: null,
  },
};

function verifyFailurePath() {
  const scenarioName = process.env.PLAN17_SCENARIO;
  const scenario = scenarios[scenarioName];
  if (!scenario) throw new Error('указан неизвестный сценарий отказа');

  for (const [key, expected] of Object.entries(scenario.outcomes)) {
    const actual = process.env[key];
    if (actual !== expected) {
      throw new Error(`сценарий «${scenarioName}»: ${key} ожидался «${expected}», получен «${actual ?? 'missing'}»`);
    }
  }

  const evidencePathValue = process.env.AUDIT_EVIDENCE_PATH;
  if (!evidencePathValue) throw new Error('не задан путь к audit evidence');
  const evidencePath = resolve(evidencePathValue);

  if (scenario.auditExitCode === null) {
    if (existsSync(evidencePath)) throw new Error('audit evidence неожиданно создан при ошибке установки');
  } else {
    if (!existsSync(evidencePath)) throw new Error('ожидаемый audit evidence не создан');

    let evidence;
    try {
      evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    } catch {
      throw new Error('audit evidence отсутствует или содержит некорректный JSON');
    }

    if (evidence.exitCode !== scenario.auditExitCode) {
      throw new Error(`сценарий «${scenarioName}»: exitCode evidence ожидался «${scenario.auditExitCode}», получен «${evidence.exitCode ?? 'missing'}»`);
    }
  }

  process.stdout.write(`Ebb Orchestrator: исходы сценария «${scenarioName}» и audit evidence подтверждены.\n`);
}

try {
  verifyFailurePath();
} catch (error) {
  process.stderr.write(`Ebb Orchestrator: проверка отказного сценария не пройдена: ${error.message}\n`);
  process.exitCode = 1;
}
