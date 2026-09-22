import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { queryCache } from '../src/state/query-cache.js';

afterEach(() => {
  cleanup();
  queryCache.clear();
});
