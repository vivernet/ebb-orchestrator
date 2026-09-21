import { describe, it, expect } from 'vitest';
import { SecretRedactor } from '../../../src/platform/security/secret-redactor.js';

describe('SecretRedactor', () => {
  describe('exact-value redaction', () => {
    it('removes exact secret values from text', () => {
      const redactor = new SecretRedactor();
      redactor.addSecret('service', 'top-secret-value');
      
      const text = 'Found top-secret-value in log';
      const result = redactor.redact(text);
      
      expect(result).toBe('Found [REDACTED] in log');
    });

    it('redacts secrets that appear at start of text', () => {
      const redactor = new SecretRedactor();
      redactor.addSecret('api', 'api-key-123');
      
      const text = 'api-key-123 is the key';
      const result = redactor.redact(text);
      
      expect(result).toBe('[REDACTED] is the key');
    });

    it('redacts secrets that appear at end of text', () => {
      const redactor = new SecretRedactor();
      redactor.addSecret('db', 'db-password');
      
      const text = 'The password is db-password';
      const result = redactor.redact(text);
      
      expect(result).toBe('The password is [REDACTED]');
    });

    it('handles multiple occurrences of same secret', () => {
      const redactor = new SecretRedactor();
      redactor.addSecret('auth', 'auth-token');
      
      const text = 'auth-token auth-token auth-token';
      const result = redactor.redact(text);
      
      expect(result).toBe('[REDACTED] [REDACTED] [REDACTED]');
    });

    it('handles multiple different secrets', () => {
      const redactor = new SecretRedactor();
      redactor.addSecret('svc1', 'secret-a');
      redactor.addSecret('svc2', 'secret-b');
      
      const text = 'Using secret-a and secret-b together';
      const result = redactor.redact(text);
      
      expect(result).toBe('Using [REDACTED] and [REDACTED] together');
    });
  });

  describe('multiline text handling', () => {
    it('redacts secrets across multiple lines', () => {
      const redactor = new SecretRedactor();
      redactor.addSecret('app', 'multiline-secret');
      
      const text = 'Line 1\nmultiline-secret\nLine 3';
      const result = redactor.redact(text);
      
      expect(result).toBe('Line 1\n[REDACTED]\nLine 3');
    });

    it('redacts secrets in JSON strings', () => {
      const redactor = new SecretRedactor();
      redactor.addSecret('config', 'config-value');
      
      const text = JSON.stringify({ key: 'config-value', other: 123 });
      const result = redactor.redact(text);
      
      expect(result).toContain('"key":"[REDACTED]"');
      expect(result).toContain('"other":123');
    });
  });

  describe('case sensitivity', () => {
    it('performs case-sensitive matching by default', () => {
      const redactor = new SecretRedactor();
      redactor.addSecret('svc', 'ExactCase');
      
      const text = 'Has ExactCase and exactcase';
      const result = redactor.redact(text);
      
      expect(result).toBe('Has [REDACTED] and exactcase');
    });
  });

  describe('empty and edge cases', () => {
    it('returns empty string unchanged', () => {
      const redactor = new SecretRedactor();
      expect(redactor.redact('')).toBe('');
    });

    it('handles text without secrets', () => {
      const redactor = new SecretRedactor();
      redactor.addSecret('svc', 'secret');
      
      const text = 'No secrets here';
      const result = redactor.redact(text);
      
    // 'secret' является подстрокой 'secrets', поэтому оно заменяется.
      expect(result).toBe('No [REDACTED]s here');
    });

    it('handles newlines and special characters', () => {
      const redactor = new SecretRedactor();
      redactor.addSecret('svc', 's3cr3t');
      
      const text = 'Line1\n\rLine2\t s3cr3t \t';
      const result = redactor.redact(text);
      
      expect(result).toBe('Line1\n\rLine2\t [REDACTED] \t');
    });
  });

  describe('special character handling', () => {
    it('handles secrets with special regex characters', () => {
      const redactor = new SecretRedactor();
      redactor.addSecret('svc', '$pecial*chars+');
      
      const text = 'Token $pecial*chars+ was used';
      const result = redactor.redact(text);
      
      expect(result).toBe('Token [REDACTED] was used');
    });

    it('handles Unicode secrets', () => {
      const redactor = new SecretRedactor();
      redactor.addSecret('svc', 'пароль-тайна');
      
      const text = 'Пароль пароль-тайна';
      const result = redactor.redact(text);
      
      expect(result).toBe('Пароль [REDACTED]');
    });
  });

  describe('service-based tracking', () => {
    it('tracks secrets by service', () => {
      const redactor = new SecretRedactor();
      redactor.addSecret('service1', 'secret-a');
      redactor.addSecret('service1', 'secret-b');
      redactor.addSecret('service2', 'secret-c');
      
      expect(redactor.getSecretCount('service1')).toBe(2);
      expect(redactor.getSecretCount('service2')).toBe(1);
      expect(redactor.getSecretCount('service3')).toBe(0);
    });

    it('returns all secrets', () => {
      const redactor = new SecretRedactor();
      redactor.addSecret('svc1', 'a');
      redactor.addSecret('svc2', 'b');
      
      const all = redactor.getAllSecrets();
      expect(all.size).toBe(2);
    });
  });
});
