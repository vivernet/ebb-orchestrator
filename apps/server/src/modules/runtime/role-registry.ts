/**
 * Role registry for Orchestrator Hermes.
 *
 * Provides runtime access to all role contracts with validation and filtering.
 */

import type { RoleContract } from './role-contract.js';
import { AllContracts } from './default-roles.js';

/**
 * Registry for accessing and managing role contracts.
 */
export class RoleRegistry {
  private contracts: Map<string, RoleContract>;

  constructor() {
    this.contracts = new Map();
    // Load all default contracts
    for (const [name, contract] of Object.entries(AllContracts)) {
      this.contracts.set(name, contract);
    }
  }

  /**
   * Получает a contract by role name.
   */
  get(roleName: string): RoleContract | undefined {
    // Обрабатывает 'developer' alias
    if (roleName === 'developer') {
      return this.contracts.get('middle_dev');
    }
    return this.contracts.get(roleName);
  }

  /**
   * Проверяет if a role exists in the registry.
   */
  has(roleName: string): boolean {
    if (roleName === 'developer') {
      return this.contracts.has('middle_dev') || this.contracts.has('senior_dev');
    }
    return this.contracts.has(roleName);
  }

  /**
   * Получает all registered contracts.
   */
  getAll(): RoleContract[] {
    return Array.from(this.contracts.values());
  }

  /**
   * Получает all role names.
   */
  getNames(): string[] {
    return Array.from(this.contracts.keys());
  }

  /**
   * Получает contracts filtered by role names.
   */
  filter(names: string[]): RoleContract[] {
    return names
      .map(name => this.get(name))
      .filter((c): c is RoleContract => c !== undefined);
  }

  /**
   * Получает contracts for roles with a specific session policy.
   */
  filterBySessionPolicy(policy: 'fresh_per_task' | 'shared' | 'task_lifetime'): RoleContract[] {
    return Array.from(this.contracts.values()).filter(
      c => c.sessionPolicy === policy
    );
  }

  /**
   * Получает contracts for roles with a specific permission profile.
   */
  filterByPermissionProfile(profile: string): RoleContract[] {
    return Array.from(this.contracts.values()).filter(
      c => c.permissionProfile === profile
    );
  }

  /**
   * Получает contracts for roles that have a specific tool.
   */
  filterByTool(tool: string): RoleContract[] {
    return Array.from(this.contracts.values()).filter(
      c => c.allowedTools.includes(tool as never)
    );
  }

  /**
   * Получает contracts for roles that do NOT have a specific tool.
   */
  filterWithoutTool(tool: string): RoleContract[] {
    return Array.from(this.contracts.values()).filter(
      c => !c.allowedTools.includes(tool as never)
    );
  }

  /**
   * Register a new contract (or override existing).
   */
  set(roleName: string, contract: RoleContract): void {
    this.contracts.set(roleName, contract);
  }

  /**
   * Remove a contract from the registry.
   */
  remove(roleName: string): boolean {
    return this.contracts.delete(roleName);
  }

  /**
   * Получает the count of registered contracts.
   */
  count(): number {
    return this.contracts.size;
  }
}

/**
 * Singleton instance for global access.
 */
export const globalRegistry = new RoleRegistry();
