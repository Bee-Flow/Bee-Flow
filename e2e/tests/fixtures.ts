/**
 * Shared Playwright fixtures for the smoke suite.
 *
 * Generated specs import from here instead of '@playwright/test':
 *
 *   import { test, expect, AUTH_FILE } from '../fixtures';
 *
 * - Scenarios with `auth: admin` add `test.use({ storageState: AUTH_FILE })`
 *   at the top of the file; the session cookie is captured once by
 *   global-setup.ts.
 * - Scenarios with `auth: none` skip that line and get a clean context.
 * - `runId` is a per-test unique slug. Every entity a test creates (agents,
 *   knowledge bases, ...) MUST embed it in the name so parallel runs never
 *   collide and leftovers are traceable.
 */
import { test as base, expect } from '@playwright/test';
import * as path from 'path';

export const AUTH_FILE = path.join(__dirname, '..', '.auth', 'admin.json');

export const test = base.extend<{ runId: string }>({
  runId: async ({}, use) => {
    const slug = `e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    await use(slug);
  },
});

export { expect };
