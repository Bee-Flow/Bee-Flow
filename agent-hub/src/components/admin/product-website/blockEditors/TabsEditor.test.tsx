/**
 * Tabs editor: the tab cap, the add button, and the link-id helpers.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, it, expect, vi } from 'vitest';

import { TabsEditor, cleanTabId, nextTabId } from './TabsEditor';

const tab = (n: number) => ({ tabId: `tab-${n}`, label: `Tab ${n}` });

describe('TabsEditor', () => {
    it('adds a tab with a fresh id and switches the button off', async () => {
        const onChange = vi.fn();
        render(<TabsEditor data={{ items: [tab(1), tab(2)] }} onChange={onChange} />);
        await userEvent.click(screen.getByRole('button', { name: /Add tab/ }));
        const items = onChange.mock.calls[0][0].items;
        expect(items).toHaveLength(3);
        expect(items[2]).toMatchObject({ tabId: 'tab-3', cta: null });
    });

    it('stops offering "Add tab" at six tabs', () => {
        render(<TabsEditor data={{ items: [1, 2, 3, 4, 5, 6].map(tab) }} onChange={() => {}} />);
        expect(screen.queryByRole('button', { name: /Add tab/ })).toBeNull();
    });

    it('asks for a second tab while there is only one', () => {
        render(<TabsEditor data={{ items: [tab(1)] }} onChange={() => {}} />);
        expect(screen.getByText(/at least two tabs/)).toBeInTheDocument();
    });
});

describe('link id helpers', () => {
    it('cleans an id to URL-safe characters', () => {
        expect(cleanTabId('Legal & DPO!')).toBe('legal-dpo-');
        expect(cleanTabId('-x')).toBe('x');
    });
    it('never reuses an id', () => {
        expect(nextTabId([tab(1), tab(3)])).toBe('tab-4');
        expect(nextTabId([])).toBe('tab-1');
    });
});
