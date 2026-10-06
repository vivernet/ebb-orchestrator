import { describe, expect, it } from 'vitest';
import {
  HERMES_PROVIDER_BASE_URL_ENV_VARS,
  HERMES_PROVIDER_SELECTION_SOURCE,
  readHermesProviderSelection,
} from '../../../src/modules/runtime/hermes/hermes-provider-selection.js';

describe('readHermesProviderSelection', () => {
  const base = {
    hermesConfigHome: '/home/alice/.hermes',
    runId: 'c9b640db-9fbf-4d1f-b8a8-91e74093772b',
    hermesRunProfileHome: '/home/alice/.hermes/profiles/ebb-orchestrator-run-c9b640db-9fbf-4d1f-b8a8-91e74093772b',
    hermesProjectRoot: '/opt/hermes-agent',
    runEnvironment: {} as Readonly<Record<string, string | undefined>>,
    helperPath: '/opt/ebb/native/ebb-hermes-profile-path',
    platform: 'linux' as const,
  };

  function projection(providerId: string, modelId: string, endpointOverridePresent = false): string {
    return JSON.stringify({
      sourceVersion: HERMES_PROVIDER_SELECTION_SOURCE.version,
      sourceCommit: HERMES_PROVIDER_SELECTION_SOURCE.commit,
      projectionVersion: HERMES_PROVIDER_SELECTION_SOURCE.projectionVersion,
      status: 'EXPLICIT_SELECTION',
      providerId,
      modelId,
      endpointOverridePresent,
    });
  }

  it('assigns source-pinned identity only to a literal endpoint with no runtime endpoint env override', async () => {
    const calls: string[][] = [];
    const result = await readHermesProviderSelection({
      ...base,
      runHelper: async (_executable, args) => {
        calls.push(args);
        return projection('fireworks', 'accounts/fireworks/models/example');
      },
    });

    expect(result).toEqual({
      providerId: 'fireworks',
      modelId: 'accounts/fireworks/models/example',
      endpointOverridePresent: false,
      endpointIdentityEligible: true,
      endpointIdentity: 'hermes-provider:fireworks',
      endpointRevision: HERMES_PROVIDER_SELECTION_SOURCE.commit,
    });
    expect(calls[0]).toEqual([
      'project-selection',
      base.hermesConfigHome,
      base.hermesRunProfileHome,
      base.runId,
    ]);
    expect(JSON.stringify(result)).not.toContain('https://');
  });

  it('keeps openai-api ineligible when the bounded source projection fails closed', async () => {
    const result = await readHermesProviderSelection({
      ...base,
      runHelper: async (_executable, args) => args[0] === 'project-selection'
        ? projection('openai-api', 'gpt-6-luna')
        : JSON.stringify({
            sourceVersion: HERMES_PROVIDER_SELECTION_SOURCE.version,
            sourceCommit: HERMES_PROVIDER_SELECTION_SOURCE.commit,
            projectionVersion: HERMES_PROVIDER_SELECTION_SOURCE.endpointProjectionVersion,
            status: 'UNAVAILABLE',
            reason: 'HERMES_ENDPOINT_ID_UNAVAILABLE',
          }),
    });

    expect(result).toMatchObject({
      providerId: 'openai-api',
      modelId: 'gpt-6-luna',
      endpointIdentityEligible: false,
      endpointIdentity: null,
      endpointRevision: null,
      reason: 'HERMES_ENDPOINT_ID_UNAVAILABLE',
    });
    expect(HERMES_PROVIDER_BASE_URL_ENV_VARS).toContain('OPENAI_BASE_URL');
    expect(JSON.stringify(result)).not.toContain('https://api.openai.com/v1');
  });

  it('accepts openai-api only when the selected endpoint dotenv projection equals its pinned literal', async () => {
    const calls: Array<{ args: string[]; options: { shell: false; maxOutputBytes: number; input?: string } }> = [];
    const result = await readHermesProviderSelection({
      ...base,
      runHelper: async (_executable: string, args: string[], options: { shell: false; maxOutputBytes: number; input?: string }) => {
        calls.push({ args, options });
        if (args[0] === 'project-selection') return projection('openai-api', 'gpt-6-luna');
        if (args[0] === 'project-endpoint') return JSON.stringify({
          sourceVersion: HERMES_PROVIDER_SELECTION_SOURCE.version,
          sourceCommit: HERMES_PROVIDER_SELECTION_SOURCE.commit,
          projectionVersion: 'hermes-endpoint-projection-v1',
          status: 'PINNED_DEFAULT',
          providerId: 'openai-api',
          baseUrlEnvVar: 'OPENAI_BASE_URL',
        });
        throw new Error('unexpected native command');
      },
    });

    expect(result).toMatchObject({
      providerId: 'openai-api',
      modelId: 'gpt-6-luna',
      endpointIdentityEligible: true,
      endpointIdentity: 'hermes-provider:openai-api',
      endpointRevision: HERMES_PROVIDER_SELECTION_SOURCE.commit,
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.args).not.toContain('https://api.openai.com/v1');
    expect(calls[1]?.args).toEqual([
      'project-endpoint',
      base.hermesConfigHome,
      base.hermesRunProfileHome,
      base.hermesProjectRoot,
      'openai-api',
      'gpt-6-luna',
      'OPENAI_BASE_URL',
      base.runId,
    ]);
    expect(calls[1]?.options.input).toBe('0\n0\n');
    expect(JSON.stringify(calls)).not.toContain('https://api.openai.com/v1');
  });

  it('sends only the selected explicit endpoint through stdin and rejects custom endpoints without disclosure', async () => {
    const calls: Array<{ args: string[]; options: { input?: string } }> = [];
    const customEndpoint = 'https://private.example.invalid/custom';
    const result = await readHermesProviderSelection({
      ...base,
      runEnvironment: { OPENAI_BASE_URL: customEndpoint },
      runHelper: async (_executable, args, options) => {
        calls.push({ args, options });
        if (args[0] === 'project-selection') return projection('openai-api', 'gpt-6-luna');
        return JSON.stringify({
          sourceVersion: HERMES_PROVIDER_SELECTION_SOURCE.version,
          sourceCommit: HERMES_PROVIDER_SELECTION_SOURCE.commit,
          projectionVersion: HERMES_PROVIDER_SELECTION_SOURCE.endpointProjectionVersion,
          status: 'UNAVAILABLE',
          reason: 'HERMES_ENDPOINT_ID_UNAVAILABLE',
        });
      },
    });

    expect(result).toMatchObject({ endpointIdentityEligible: false, reason: 'HERMES_ENDPOINT_ID_UNAVAILABLE' });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.args).not.toContain(customEndpoint);
    expect(calls[1]?.options.input).toBe(`1\n${Buffer.byteLength(customEndpoint, 'utf8')}\n${customEndpoint}`);
    expect(JSON.stringify(result)).not.toContain(customEndpoint);
  });

  it('fails closed before endpoint projection when a managed override is present in the prepared Run environment', async () => {
    const calls: string[] = [];
    const result = await readHermesProviderSelection({
      ...base,
      runEnvironment: { HERMES_MANAGED_DIR: '/managed/hermes' },
      runHelper: async (_executable, args) => {
        calls.push(args[0] ?? '');
        return projection('openai-api', 'gpt-6-luna');
      },
    });

    expect(result).toMatchObject({ endpointIdentityEligible: false, reason: 'HERMES_ENDPOINT_ID_UNAVAILABLE' });
    expect(calls).toEqual(['project-selection']);
  });

  it('pins the complete source-defined base_url_env_var name set without reading any values', () => {
    expect(HERMES_PROVIDER_BASE_URL_ENV_VARS).toEqual([
      'ACTUAL_BASE_URL',
      'ALIBABA_CODING_PLAN_BASE_URL',
      'ARCEE_BASE_URL',
      'AZURE_FOUNDRY_BASE_URL',
      'COPILOT_ACP_BASE_URL',
      'DASHSCOPE_BASE_URL',
      'DEEPSEEK_BASE_URL',
      'GLM_BASE_URL',
      'GMI_BASE_URL',
      'HERMES_QWEN_BASE_URL',
      'HF_BASE_URL',
      'KILOCODE_BASE_URL',
      'KIMI_BASE_URL',
      'LM_BASE_URL',
      'MINIMAX_BASE_URL',
      'MINIMAX_CN_BASE_URL',
      'NEBIUS_BASE_URL',
      'NOVITA_BASE_URL',
      'NVIDIA_BASE_URL',
      'OLLAMA_BASE_URL',
      'OPENAI_BASE_URL',
      'OPENCODE_GO_BASE_URL',
      'OPENCODE_ZEN_BASE_URL',
      'OPENROUTER_BASE_URL',
      'STEPFUN_BASE_URL',
      'TOKENHUB_BASE_URL',
      'TOKENPLAN_BASE_URL',
      'UPSTAGE_BASE_URL',
      'XAI_BASE_URL',
      'XIAOMI_BASE_URL',
    ]);
  });

  it('detects a config endpoint override without disclosing its value', async () => {
    const result = await readHermesProviderSelection({
      ...base,
      runHelper: async () => projection('fireworks', 'vendor/model-v1', true),
    });

    expect(result).toMatchObject({
      endpointOverridePresent: true,
      endpointIdentityEligible: false,
      endpointIdentity: null,
      endpointRevision: null,
      reason: 'HERMES_ENDPOINT_ID_UNAVAILABLE',
    });
    expect(JSON.stringify(result)).not.toMatch(/https?:|private\.example/u);
  });

  it('rejects dynamic models.dev-only endpoints', async () => {
    const result = await readHermesProviderSelection({
      ...base,
      runHelper: async () => projection('anthropic', 'claude-sonnet'),
    });

    expect(result).toMatchObject({
      endpointIdentityEligible: false,
      endpointIdentity: null,
      endpointRevision: null,
      reason: 'HERMES_ENDPOINT_ID_UNAVAILABLE',
    });
  });

  it('fails closed when pinned source identity is stale or helper output is malformed', async () => {
    await expect(readHermesProviderSelection({
      ...base,
      runHelper: async () => JSON.stringify({
        sourceVersion: HERMES_PROVIDER_SELECTION_SOURCE.version,
        sourceCommit: 'changed',
        projectionVersion: HERMES_PROVIDER_SELECTION_SOURCE.projectionVersion,
        status: 'EXPLICIT_SELECTION',
        providerId: 'fireworks',
        modelId: 'm',
        endpointOverridePresent: false,
      }),
    })).rejects.toThrow('HERMES_SELECTION_SOURCE_MISMATCH');
    await expect(readHermesProviderSelection({
      ...base,
      runHelper: async () => '{not-json',
    })).rejects.toThrow('HERMES_SELECTION_PROJECTION_INVALID');
  });

  it('rejects an implicit/auto provider and missing explicit model', async () => {
    await expect(readHermesProviderSelection({
      ...base,
      runHelper: async () => projection('auto', 'vendor/model-v1'),
    })).rejects.toThrow('HERMES_SELECTION_NOT_EXPLICIT');
    await expect(readHermesProviderSelection({
      ...base,
      runHelper: async () => projection('fireworks', ''),
    })).rejects.toThrow('HERMES_SELECTION_NOT_EXPLICIT');
  });

  it('rejects a non-canonical Run UUID before invoking the native helper', async () => {
    const calls: string[] = [];
    await expect(readHermesProviderSelection({
      ...base,
      runId: 'not-a-uuid',
      runHelper: async (_executable, args) => {
        calls.push(args[0] ?? '');
        return projection('openai-api', 'gpt-6-luna');
      },
    })).rejects.toThrow('HERMES_SELECTION_INPUT_INVALID');
    expect(calls).toEqual([]);
  });
});
