/**
 * The Compliance demo answers every request the hub makes, on load and on
 * every section and header tab a visitor can reach.
 *
 * DemoHost.test.jsx covers the first screen of every demo. The Compliance
 * Center asks for most of its data only when a section opens (the ROPA
 * projects list, the access log's filter options, a register's drawer data),
 * so a route missing from the fixture showed up only in a visitor's console
 * ("[demo] no fixture for GET /api/compliance/ropa/projects") over an empty
 * panel. This walks the rail like a visitor and fails on that warning, and on
 * React's duplicate-key warning, which the access log's filter pills raised
 * while the fixture served its actions as bare strings.
 *
 * Run: cd agent-hub && npx vitest run src/demo/ComplianceDemo.test.tsx
 */
import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import DemoHost from './DemoHost';

const settle = () => new Promise(r => setTimeout(r, 200));

let missing: string[];
let duplicateKeys: string[];
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    missing = [];
    duplicateKeys = [];
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
        const first = String(args[0] ?? '');
        if (first.startsWith('[demo] no fixture for')) missing.push(first);
    });
    errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        const text = args.map(String).join(' ');
        if (/same key/i.test(text)) duplicateKeys.push(text.slice(0, 200));
    });
});

afterEach(() => {
    fetchSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
});

describe('the Compliance demo, section by section', () => {
    it('has a fixture for every route the rail and the header tabs lead to', async () => {
        const user = userEvent.setup();
        render(<DemoHost feature="compliance" />);
        await waitFor(() => expect(document.querySelector('[data-testid="rail-row-overview"]')).not.toBeNull(), { timeout: 20_000 });
        await settle();

        const rows = [...document.querySelectorAll<HTMLElement>('[data-testid^="rail-row-"]')]
            .map(el => el.getAttribute('data-testid') as string);
        expect(rows.length).toBeGreaterThan(15);
        const visited: string[] = [];
        for (const testId of rows) {
            await user.click(screen.getByTestId(testId));
            await settle();
            visited.push(testId);
            // The header's tabs are a SegmentedControl (radios), or a menu of
            // radios once the header folds.
            const header = screen.getAllByTestId('compliance-header')[0];
            const labels = within(header).queryAllByRole('radio').map(r => r.getAttribute('aria-label') || r.textContent || '');
            for (const label of labels.slice(1)) {
                await user.click(within(screen.getAllByTestId('compliance-header')[0]).getAllByRole('radio').find(r => (r.getAttribute('aria-label') || r.textContent || '') === label) as HTMLElement);
                await settle();
                visited.push(`${testId} › ${label}`);
            }
        }

        expect(visited.length).toBeGreaterThan(rows.length);
        expect(visited).toEqual(expect.arrayContaining(['rail-row-ropa', 'rail-row-access_log', 'rail-row-connectors']));
        expect(missing, `unfixtured routes:\n  ${missing.join('\n  ')}`).toEqual([]);
        expect(duplicateKeys, duplicateKeys.join('\n')).toEqual([]);
        expect(fetchSpy).not.toHaveBeenCalled();
    }, 120_000);
});
