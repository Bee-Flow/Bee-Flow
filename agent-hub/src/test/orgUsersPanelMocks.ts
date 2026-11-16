// The module stand-ins of the OrgUsersPanel suites (OrgUsersPanel.test.tsx and
// OrgUsersPanel.groups.test.tsx). Opt in from a test with:
//   vi.mock('@/hooks/useUrlTab', () => import('@/test/orgUsersPanelMocks'));
//   vi.mock('@/components/shared/Toast', () => import('@/test/orgUsersPanelMocks'));
// The test reads `tab` and `toast` from this module: the same instance the panel got.
import { vi } from 'vitest';

/** The section under test, chosen by the test; every setActiveSection() call is recorded instead of touching history. */
export const tab: { section: string; navigated: string[]; basePath: string | null } = { section: 'users', navigated: [], basePath: null };

/** useUrlTab, answering `tab.section` and recording the address it was given. */
export function useUrlTab({ basePath }: { basePath: string }): [string, (v: string) => void] {
    tab.basePath = basePath;
    return [tab.section, (v: string) => { tab.navigated.push(v); }];
}

export const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
