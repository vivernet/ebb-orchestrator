import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import * as path from 'node:path';

/** Тип и допустимые значения одного позиционного аргумента команды. */
export type CommandArgumentSchema =
  | { type: 'string'; enum?: string[]; pattern?: string }
  | { type: 'workspace-path' };

/** Описывает заранее разрешённую команду для одного capability. */
export type CommandPolicyDefinition = {
  /** Уникальный стабильный ID команды внутри capability. */
  id: string;
  /** Неизменяемый executable, который запускает Orchestrator. */
  executable: string;
  /** Точная схема позиционных аргументов; каждый элемент должен пройти свою проверку. */
  args: CommandArgumentSchema[];
  /** Существующие каталоги внутри workspace, разрешённые для path-аргументов. */
  allowedRoots: string[];
  /** Верхняя граница времени исполнения в миллисекундах. */
  timeout: number;
  /** Верхняя граница захвата stdout и stderr для каждого потока. */
  maxOutput: number;
};

/** Запрос агента ссылается на policy ID; executable, cwd и лимиты он не задаёт. */
export type CommandInvocation = { policyId: string; args: unknown[] };
export type ValidatedCommand = { executable: string; args: string[]; cwd: string; timeout: number; maxOutput: number };

const MAX_TIMEOUT = 5 * 60 * 1000;
const MAX_OUTPUT = 1024 * 1024;
const SHELL_EXECUTABLES = new Set(['bash', 'sh', 'zsh', 'cmd', 'powershell', 'pwsh']);
const SHELL_METACHARACTERS = /[\0\r\n;&|<>`$(){}]/;

function canonical(pathname: string): string | undefined {
  if (!path.isAbsolute(pathname)) return undefined;
  try {
    return realpathSync(pathname);
  } catch {
    return undefined;
  }
}

function isDirectory(pathname: string): boolean {
  try { return statSync(pathname).isDirectory(); } catch { return false; }
}

function canonicalCandidate(base: string, candidate: string): string | undefined {
  const resolvedCandidate = path.resolve(base, candidate);
  if (!isWithin(normalizeForComparison(base), normalizeForComparison(resolvedCandidate))) return undefined;
  let ancestor = base;
  const segments = path.relative(base, resolvedCandidate).split(path.sep).filter(Boolean);
  for (const segment of segments) {
    ancestor = path.join(ancestor, segment);
    try {
      if (lstatSync(ancestor).isSymbolicLink()) return undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      return undefined;
    }
  }

  let unresolved = resolvedCandidate;
  const suffix: string[] = [];
  while (!existsSync(unresolved)) {
    const parent = path.dirname(unresolved);
    if (parent === unresolved) return undefined;
    suffix.unshift(path.basename(unresolved));
    unresolved = parent;
  }
  const existing = canonical(unresolved);
  return existing ? path.resolve(existing, ...suffix) : undefined;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function normalizeForComparison(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** Проверяет декларации capability до регистрации и исполнения команд. */
export function validateCommandPolicies(workspace: string, policies: unknown): policies is CommandPolicyDefinition[] {
  if (!Array.isArray(policies)) return false;
  const canonicalWorkspace = canonical(workspace);
  if (!canonicalWorkspace) return false;
  const ids = new Set<string>();
  for (const value of policies) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const policy = value as Partial<CommandPolicyDefinition>;
    if (typeof policy.id !== 'string' || !/^[a-z][a-z0-9._-]{0,63}$/.test(policy.id) || ids.has(policy.id)) return false;
    ids.add(policy.id);
    if (typeof policy.executable !== 'string' || policy.executable.trim() === '' || SHELL_EXECUTABLES.has(path.basename(policy.executable).toLowerCase().replace(/\.exe$/, ''))) return false;
    if (!Array.isArray(policy.args) || !policy.args.every((arg) => {
      if (!arg || typeof arg !== 'object' || Array.isArray(arg)) return false;
      if (arg.type === 'workspace-path') return Object.keys(arg).length === 1;
      if (arg.type !== 'string') return false;
      const schema = arg as Extract<CommandArgumentSchema, { type: 'string' }>;
      return (schema.enum === undefined || (Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.every((item) => typeof item === 'string'))) &&
        (schema.pattern === undefined || (typeof schema.pattern === 'string' && schema.pattern.length <= 256 && isValidPattern(schema.pattern))) &&
        (schema.enum !== undefined || schema.pattern !== undefined) &&
        Object.keys(schema).every((key) => ['type', 'enum', 'pattern'].includes(key));
    })) return false;
    if (!Array.isArray(policy.allowedRoots) || policy.allowedRoots.length === 0 || !policy.allowedRoots.every((root) => {
      if (typeof root !== 'string') return false;
      const resolved = canonical(root);
      return resolved !== undefined && isDirectory(resolved) &&
        isWithin(normalizeForComparison(canonicalWorkspace), normalizeForComparison(resolved));
    })) return false;
    if (!Number.isSafeInteger(policy.timeout) || policy.timeout! < 1 || policy.timeout! > MAX_TIMEOUT) return false;
    if (!Number.isSafeInteger(policy.maxOutput) || policy.maxOutput! < 1 || policy.maxOutput! > MAX_OUTPUT) return false;
    if (Object.keys(value).some((key) => !['id', 'executable', 'args', 'allowedRoots', 'timeout', 'maxOutput'].includes(key))) return false;
  }
  return true;
}

function isValidPattern(pattern: string): boolean {
  try { new RegExp(pattern); return true; } catch { return false; }
}

/** Разрешает только зарегистрированную команду и валидирует её аргументы/пути. */
export class CommandPolicy {
  private readonly policies = new Map<string, CommandPolicyDefinition>();
  private readonly workspace: string;

  constructor(workspace: string, policies: CommandPolicyDefinition[]) {
    const resolvedWorkspace = canonical(workspace);
    if (!resolvedWorkspace || !validateCommandPolicies(resolvedWorkspace, policies)) {
      throw new Error('Invalid command policy configuration');
    }
    this.workspace = resolvedWorkspace;
    for (const policy of policies) this.policies.set(policy.id, policy);
  }

  definitions(): readonly CommandPolicyDefinition[] {
    return [...this.policies.values()];
  }

  resolve(invocation: CommandInvocation): { valid: true; command: ValidatedCommand } | { valid: false; error: string } {
    if (!invocation || typeof invocation.policyId !== 'string' || !Array.isArray(invocation.args)) {
      return { valid: false, error: 'invalid command policy invocation' };
    }
    const policy = this.policies.get(invocation.policyId);
    if (!policy) return { valid: false, error: 'unknown command policy' };
    if (invocation.args.length !== policy.args.length) return { valid: false, error: 'command arguments do not match policy schema' };

    const roots = policy.allowedRoots.map((root) => canonical(root)!);
    const args: string[] = [];
    for (const [index, raw] of invocation.args.entries()) {
      const schema = policy.args[index]!;
      if (typeof raw !== 'string' || raw.trim() === '' || SHELL_METACHARACTERS.test(raw)) {
        return { valid: false, error: 'command argument is not allowed by policy' };
      }
      if (schema.type === 'workspace-path') {
        const candidate = canonicalCandidate(this.workspace, raw);
        if (!candidate || !roots.some((root) => isWithin(normalizeForComparison(root), normalizeForComparison(candidate)))) {
          return { valid: false, error: 'command path is outside allowed roots' };
        }
      } else {
        if (schema.enum && !schema.enum.includes(raw)) return { valid: false, error: 'command argument is not in the declared enum' };
        if (schema.pattern && !new RegExp(schema.pattern).test(raw)) return { valid: false, error: 'command argument does not match the declared pattern' };
      }
      args.push(raw);
    }

    return { valid: true, command: {
      executable: policy.executable,
      args,
      cwd: this.workspace,
      timeout: policy.timeout,
      maxOutput: policy.maxOutput,
    } };
  }
}
