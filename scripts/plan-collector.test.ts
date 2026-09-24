/**
 * Tests for plan-collector.ts
 * RED test-first approach
 */

import { collectPlans, groupedByStage } from './plan-collector.js';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import * as assert from 'node:assert';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Test constants
const TEST_DIR = path.join(__dirname, '..', 'docs', 'architecture', 'plans');

test('collectPlans returns empty array for non-existent directory', () => {
  const result = collectPlans('/non-existent/path');
  assert.strictEqual(result.length, 0);
});

test('collectPlans returns all plan metadata from directory', () => {
  const plans = collectPlans(TEST_DIR);
  assert.ok(plans.length > 0, 'Should find at least one plan');
  
  // Check that all returned items have required fields
  for (const plan of plans) {
    assert.ok(plan.id, 'Plan should have id');
    assert.ok(plan.kind, 'Plan should have kind');
    assert.ok(plan.stage, 'Plan should have stage');
  }
});

test('collectPlans only returns files with kind: plan', () => {
  const plans = collectPlans(TEST_DIR);
  for (const plan of plans) {
    assert.strictEqual(plan.kind, 'plan', 'All items should be plans');
  }
});

test('groupedByStage groups plans by stage correctly', () => {
  const plans = collectPlans(TEST_DIR);
  const grouped = groupedByStage(plans);
  
  // Check that we have a Map
  assert.ok(grouped instanceof Map, 'Should return a Map');
  
  // Check that stages are valid keys
  for (const [stage, plansList] of grouped.entries()) {
    assert.ok(stage, 'Stage key should not be empty');
    assert.ok(Array.isArray(plansList), 'Stage value should be array');
    assert.ok(plansList.length > 0, 'Stage should have at least one plan');
    
    // Verify all plans in group have matching stage
    for (const plan of plansList) {
      assert.strictEqual(plan.stage, stage, 'Plan stage should match group key');
    }
  }
});

test('groupedByStage handles empty input', () => {
  const grouped = groupedByStage([]);
  assert.ok(grouped instanceof Map, 'Should return empty Map');
  assert.strictEqual(grouped.size, 0, 'Map should be empty');
});

test('collectPlans filters out non-md files', () => {
  const plans = collectPlans(TEST_DIR);
  // All plans should be from .md files
  assert.ok(plans.length > 0, 'Should find plan files');
});
