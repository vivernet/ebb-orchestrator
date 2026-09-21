import { describe, expect, it } from 'vitest';
import { globalRegistry } from '../../../src/modules/runtime/role-registry.js';
import { AllContracts, getContract } from '../../../src/modules/runtime/default-roles.js';
import { SUPPORTED_TOOL_IDS } from '../../../src/modules/execution/run-capability.js';

describe('RoleRegistry', () => {
  describe('initialization', () => {
    it('should have 9 registered roles', () => {
      expect(globalRegistry.count()).toBe(9);
    });

    it('should register all expected role names', () => {
      const names = globalRegistry.getNames();
      expect(names).toContain('coordinator');
      expect(names).toContain('product_manager');
      expect(names).toContain('architect');
      expect(names).toContain('middle_dev');
      expect(names).toContain('senior_dev');
      expect(names).toContain('devops');
      expect(names).toContain('reviewer');
      expect(names).toContain('qa');
      expect(names).toContain('integration');
    });
  });

  describe('get', () => {
    it('should get coordinator contract', () => {
      const contract = globalRegistry.get('coordinator');
      expect(contract).toBeDefined();
      expect(contract?.name).toBe('coordinator');
      expect(contract?.displayName).toBe('Coordinator');
    });

    it('should get developer contract (alias for middle_dev)', () => {
      const contract = globalRegistry.get('developer');
      expect(contract).toBeDefined();
      expect(contract?.name).toBe('middle_dev');
    });

    it('should return undefined for unknown role', () => {
      const contract = globalRegistry.get('unknown_role');
      expect(contract).toBeUndefined();
    });
  });

  describe('filterBySessionPolicy', () => {
    it('should return fresh_per_task roles (reviewer, qa, integration)', () => {
      const roles = globalRegistry.filterBySessionPolicy('fresh_per_task');
      expect(roles.map(r => r.name)).toEqual(['reviewer', 'qa', 'integration']);
    });

    it('should return shared roles (architect, developers)', () => {
      const roles = globalRegistry.filterBySessionPolicy('shared');
      expect(roles.map(r => r.name)).toEqual([
        'architect',
        'middle_dev',
        'senior_dev',
      ]);
    });
  });

  describe('filterByTool', () => {
    it('should return roles with workspace.patch', () => {
      const roles = globalRegistry.filterByTool('workspace.patch');
      expect(roles.map(r => r.name)).toContain('architect');
      expect(roles.map(r => r.name)).toContain('middle_dev');
      expect(roles.map(r => r.name)).toContain('senior_dev');
      expect(roles.map(r => r.name)).toContain('devops');
    });

    it('should NOT return reviewer/qa/integration with workspace.patch', () => {
      const roles = globalRegistry.filterByTool('workspace.patch');
      expect(roles.map(r => r.name)).not.toContain('reviewer');
      expect(roles.map(r => r.name)).not.toContain('qa');
      expect(roles.map(r => r.name)).not.toContain('integration');
    });

    it('should return roles with git.commit', () => {
      const roles = globalRegistry.filterByTool('git.commit');
      expect(roles.map(r => r.name)).toContain('middle_dev');
      expect(roles.map(r => r.name)).toContain('senior_dev');
    });

    it('should NOT return reviewer/qa/integration with git.commit', () => {
      const roles = globalRegistry.filterByTool('git.commit');
      expect(roles.map(r => r.name)).not.toContain('reviewer');
      expect(roles.map(r => r.name)).not.toContain('qa');
      expect(roles.map(r => r.name)).not.toContain('integration');
    });

    it('should not expose the unsupported command.shell tool', () => {
      const roles = globalRegistry.filterByTool('command.shell');
      expect(roles).toHaveLength(0);
    });

    it('should NOT return reviewer with command.shell', () => {
      const roles = globalRegistry.filterByTool('command.shell');
      expect(roles.map(r => r.name)).not.toContain('reviewer');
    });
  });

  describe('filterWithoutTool', () => {
    it('should return reviewer/qa/integration without workspace.patch', () => {
      const roles = globalRegistry.filterWithoutTool('workspace.patch');
      expect(roles.map(r => r.name)).toContain('reviewer');
      expect(roles.map(r => r.name)).toContain('qa');
      expect(roles.map(r => r.name)).toContain('integration');
    });

    it('should return reviewer/qa/integration without git.commit', () => {
      const roles = globalRegistry.filterWithoutTool('git.commit');
      expect(roles.map(r => r.name)).toContain('reviewer');
      expect(roles.map(r => r.name)).toContain('qa');
      expect(roles.map(r => r.name)).toContain('integration');
    });

    it('should return reviewer/qa/integration without command.shell', () => {
      const roles = globalRegistry.filterWithoutTool('command.shell');
      expect(roles.map(r => r.name)).toContain('reviewer');
      expect(roles.map(r => r.name)).toContain('qa');
      expect(roles.map(r => r.name)).toContain('integration');
    });
  });

  describe('tool surfaces per role (snapshot tests)', () => {
    it('keeps every role tool in the typed supported MCP surface', () => {
      const supported = new Set<string>(SUPPORTED_TOOL_IDS);
      for (const contract of Object.values(AllContracts)) {
        for (const tool of contract.allowedTools) {
          expect(supported.has(tool), `${contract.name} exposes unsupported ${tool}`).toBe(true);
        }
      }
    });

    it('should have correct tools for reviewer', () => {
      const contract = getContract('reviewer');
      expect(contract).toBeDefined();
      expect(contract?.allowedTools).toEqual([
        'workspace.read',
        'workspace.search',
        'project.test',
        'project.lint',
        'project.typecheck',
        'git.status',
        'git.diff',
        'submit_result',
      ]);
      // Проверяем ограничения.
      expect(contract?.allowedTools).not.toContain('workspace.patch');
      expect(contract?.allowedTools).not.toContain('git.commit');
      expect(contract?.allowedTools).not.toContain('command.shell');
    });

    it('should have correct tools for qa', () => {
      const contract = getContract('qa');
      expect(contract).toBeDefined();
     expect(contract?.allowedTools).toEqual([
        'workspace.read',
        'workspace.search',
        'project.test',
        'project.lint',
        'git.status',
        'git.diff',
        'submit_result',
      ]);
    });

    it('should have correct tools for integration', () => {
      const contract = getContract('integration');
      expect(contract).toBeDefined();
     expect(contract?.allowedTools).toEqual([
        'workspace.read',
        'workspace.search',
        'git.status',
        'git.diff',
        'project.test',
        'submit_result',
      ]);
    });

    it('should have correct tools for developer', () => {
      const contract = getContract('developer');
      expect(contract).toBeDefined();
      expect(contract?.allowedTools).toEqual([
        'workspace.read',
        'workspace.search',
        'workspace.patch',
        'project.test',
        'project.lint',
        'project.typecheck',
        'project.build',
        'command.exec',
        'git.status',
        'git.diff',
        'git.commit',
        'submit_result',
      ]);
      // Проверяем ограничения: без изменений git.push, merge.default и конфигурации permissions.
      expect(contract?.allowedTools).not.toContain('git.push');
      expect(contract?.allowedTools).not.toContain('permission.config.mutate');
    });

    it('should have correct session policy for reviewer', () => {
      const contract = getContract('reviewer');
      expect(contract?.sessionPolicy).toBe('fresh_per_task');
    });

    it('should have correct session policy for qa', () => {
      const contract = getContract('qa');
      expect(contract?.sessionPolicy).toBe('fresh_per_task');
    });

    it('should have correct session policy for integration', () => {
      const contract = getContract('integration');
      expect(contract?.sessionPolicy).toBe('fresh_per_task');
    });

    it('should have correct session policy for developer', () => {
      const contract = getContract('developer');
      expect(contract?.sessionPolicy).toBe('shared');
    });

    it('should have correct output schema reference for reviewer', () => {
      const contract = getContract('reviewer');
      expect(contract?.outputSchema.path).toContain('ReviewerOutputSchema');
    });

    it('should have correct output schema reference for qa', () => {
      const contract = getContract('qa');
      expect(contract?.outputSchema.path).toContain('QaOutputSchema');
    });

    it('should have correct output schema reference for integration', () => {
      const contract = getContract('integration');
      expect(contract?.outputSchema.path).toContain('IntegrationOutputSchema');
    });

    it('should have correct output schema reference for developer', () => {
      const contract = getContract('developer');
      expect(contract?.outputSchema.path).toContain('DeveloperOutputSchema');
    });

    it.each([
      ['coordinator', 'CoordinatorOutputSchema'],
      ['product_manager', 'ProductDefinitionSchema'],
      ['architect', 'DesignResultSchema'],
      ['devops', 'DevOpsOutputSchema'],
    ])('should wire %s to its specialized output schema', (role, schemaName) => {
      const contract = getContract(role);
      expect(contract?.outputSchema.path).toBe(`@ebb-orchestrator/contracts#${schemaName}`);
    });
  });
});
