import { ProcessExecutor } from "../../platform/process/process-executor.js";

/** Git's refname rules relevant to untrusted branch/ref inputs. */
export function assertSafeGitRef(ref: string): void {
  const hasControl = [...ref].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f);
  const components = ref.split('/');
  if (!ref || ref === '@' || hasControl || ref.startsWith("-") || ref.startsWith("/") || ref.endsWith("/") ||
      ref.endsWith(".") || ref.includes("..") || ref.includes("@{") || /[ ~^:?*[\\;]/.test(ref) ||
      components.some((component) => component === '' || component === '.' || component === '..' ||
        component.startsWith('.') || component.endsWith('.lock'))) {
    throw new Error("Invalid Git ref");
  }
}

/**
 * Экспортируемый компонент или контракт модуля, доступный другим слоям приложения.
 */
export class GitCli {
  private readonly executor: ProcessExecutor;

  constructor(executor?: ProcessExecutor) {
    this.executor = executor ?? new ProcessExecutor();
  }

  async run(repoPath: string, args: string[]): Promise<Awaited<ReturnType<ProcessExecutor["exec"]>>> {
    return this.executor.exec("git", args, {
      cwd: repoPath,
      timeout: 60000,
      maxBuffer: 2 * 1024 * 1024,
    });
  }
}
