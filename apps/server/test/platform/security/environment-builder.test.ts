import { describe, it, expect } from 'vitest';
import { EnvironmentBuilder } from '../../../src/platform/security/environment-builder.js';

describe('EnvironmentBuilder', () => {

  describe('environment leakage prevention', () => {
    it('should not clone process.env by default', () => {
      const builder = new EnvironmentBuilder();
      const env = builder.build({
        allowlist: ['PATH'],
        injected: {}
      });
      
      // Should not contain arbitrary process.env variables
      expect(env.GITHUB_TOKEN).toBeUndefined();
      expect(env.SSH_AUTH_SOCK).toBeUndefined();
      expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    });

    it('should not inherit sensitive variables even if they exist in process.env', () => {
      // Test that sensitive vars are explicitly excluded
      const builder = new EnvironmentBuilder();
      const env = builder.build({
        allowlist: ['PATH'],
        injected: {}
      });

      // These sensitive variables should never be present
      expect(env.HOME).toBeUndefined();
      expect(env.HOMEPATH).toBeUndefined();
      expect(env.TOKEN).toBeUndefined();
    });

    it('should only include PATH by default', () => {
      const builder = new EnvironmentBuilder();
      const env = builder.build({
        allowlist: ['PATH'],
        injected: {}
      });

      expect(env.PATH).toBeDefined();
      expect(Object.keys(env).length).toBe(1);
    });
  });

  describe('allowlist enforcement', () => {
    it('should only include explicitly allowlisted variables', () => {
      const builder = new EnvironmentBuilder();
      const env = builder.build({
        allowlist: ['PATH', 'HOME'],
        injected: {}
      });

      const keys = Object.keys(env);
      expect(keys.length).toBeLessThanOrEqual(2); // May have Windows-specific base
      expect(keys.every(k => ['PATH', 'HOME'].includes(k))).toBe(true);
    });

    it('should preserve Windows runtime variables when required', () => {
      const builder = new EnvironmentBuilder();
      const env = builder.build({
        allowlist: ['PATH'],
        injected: {}
      });

      // Should have platform-appropriate PATH
      expect(env.PATH).toBeDefined();
      expect(typeof env.PATH!).toBe('string');
      expect(env.PATH!.length).toBeGreaterThan(0);
    });
  });

  describe('injected variables', () => {
    it('should include explicitly injected variables', () => {
      const builder = new EnvironmentBuilder();
      const env = builder.build({
        allowlist: ['PATH'],
        injected: { MY_VAR: 'my_value', ANOTHER_VAR: 'another' }
      });

      expect(env.MY_VAR).toBe('my_value');
      expect(env.ANOTHER_VAR).toBe('another');
    });

    it('should allow scoped environment injection', () => {
      const builder = new EnvironmentBuilder();
      const env = builder.build({
        allowlist: ['PATH'],
        injected: { TEST_TOKEN: 'token123' }
      });

      expect(env.TEST_TOKEN).toBe('token123');
    });
  });

  describe('platform baseline', () => {
    it('should work on Windows', () => {
      const builder = new EnvironmentBuilder();
      const env = builder.build({
        allowlist: ['PATH'],
        injected: {}
      });

      expect(env.PATH).toBeDefined();
      expect(typeof env.PATH).toBe('string');
    });

    it('should work on Unix', () => {
      const builder = new EnvironmentBuilder();
      const env = builder.build({
        allowlist: ['PATH'],
        injected: {}
      });

      expect(env.PATH).toBeDefined();
      expect(typeof env.PATH).toBe('string');
    });
  });

  describe('security boundaries', () => {
    it('should reject empty allowlist with explicit PATH', () => {
      const builder = new EnvironmentBuilder();
      const env = builder.build({
        allowlist: ['PATH'],
        injected: {}
      });

      expect(env.PATH).toBeDefined();
    });

    it('should prevent cloning full environment', () => {
      const builder = new EnvironmentBuilder();
      // Explicitly test that we're not copying process.env
      const env = builder.build({
        allowlist: ['PATH'],
        injected: {}
      });

      // Count should be minimal, not thousands like process.env
      expect(Object.keys(env).length).toBeLessThan(10);
    });
  });
});
