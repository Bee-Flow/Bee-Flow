import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import AttentionList from './AttentionList';

function tr(key, fallbackOrParams, paramsArg) {
    const hasFallback = typeof fallbackOrParams === 'string';
    const params = hasFallback ? paramsArg : fallbackOrParams;
    let value = hasFallback ? fallbackOrParams : key;
    if (params && typeof params === 'object') {
        for (const [k, v] of Object.entries(params)) value = value.split(`{${k}}`).join(String(v));
    }
    return value;
}
vi.mock('../../../../../hooks/useTranslation', () => ({
    useTranslation: () => ({ t: tr, locale: 'en', resolvedLocale: 'en' }),
}));

const ITEMS = [
    {
        id: 'GDPR-Art12-notice', code: 'GDPR-Art12-notice', title: 'Privacy notice not published', status: 'fail',
        meta: {
            severity: 'high', verification: 'attestation', detail: 'URL missing in Settings',
            frameworks: [{ regulation: 'GDPR', ref: '12' }],
        },
        action: { type: 'navigate', target: '/app/settings/organisation/compliance/settings', label: 'Set up' },
    },
    {
        id: 'AIA-Art50-marking', code: 'AIA-Art50-marking', title: 'AI disclosure missing on 2 published agents', status: 'fail',
        meta: { severity: 'high', verification: 'automated', frameworks: [{ regulation: 'AIA', ref: '50' }] },
        action: { type: 'auto_fix', count: 2 },
    },
    {
        id: 'GDPR-Art4-literacy', code: 'GDPR-Art4-literacy', title: 'AI literacy not confirmed this year', status: 'warn',
        meta: { severity: 'medium', verification: 'attestation', frameworks: [{ regulation: 'AIA', ref: '4' }] },
        action: { type: 'open_fix', target: 'admin/security/guardrails', label: 'Open fix' },
    },
    {
        id: 'ISO-A.5.1-policy', code: 'ISO-A.5.1-policy', title: 'Information security policy not approved', status: 'pass',
        meta: { frameworks: [{ regulation: 'ISO27001', ref: 'A.5.1' }] },
        action: null,
    },
];

const ATTENTION = { items: ITEMS, total: 4 };

function renderList(props = {}) {
    const navigate = vi.fn();
    const onNavigate = vi.fn();
    const onAutoFix = vi.fn();
    const utils = render(
        <AttentionList attention={ATTENTION} items={ITEMS} navigate={navigate} onNavigate={onNavigate} onAutoFix={onAutoFix} {...props} />,
    );
    return { ...utils, navigate, onNavigate, onAutoFix, user: userEvent.setup() };
}

/** Twelve open items, like the Overview of an org with work to do. */
const MANY = Array.from({ length: 12 }, (_, i) => ({
    id: `item-${i}`, code: `CHECK-${i}`, title: `Open item ${i + 1}`, status: i < 4 ? 'fail' : 'warn',
    meta: { severity: 'medium', verification: 'automated', frameworks: [{ regulation: i % 2 ? 'ISO27001' : 'GDPR', ref: i % 2 ? 'A.5.1' : '30' }] },
    action: { type: 'open_fix', target: 'admin/compliance/ropa', label: 'Open fix' },
}));

describe('AttentionList', () => {
    it('renders the rows with glyph, refs, severity and verification', () => {
        renderList();
        const rows = screen.getAllByTestId('attention-list-row');
        expect(rows).toHaveLength(4);
        expect(rows[0].dataset.status).toBe('fail');
        expect(rows[0].textContent).toContain('GDPR Art. 12');
        expect(rows[0].textContent).toContain('URL missing in Settings');
        expect(screen.getByTestId('attention-list-count').textContent).toBe('4');
    });

    it('shows a severity tag on open rows only (design rule 5)', () => {
        renderList();
        const rows = screen.getAllByTestId('attention-list-row');
        expect(within(rows[0]).getByTestId('severity-tag')).toBeInTheDocument();
        expect(within(rows[3]).queryByTestId('severity-tag')).not.toBeInTheDocument();
    });

    it('an unread list is its own state — one line, never an empty list', () => {
        renderList({ attention: null, items: null, failed: true });
        expect(screen.getByTestId('attention-list-unavailable')).toBeInTheDocument();
        expect(screen.queryByTestId('attention-list-rows')).not.toBeInTheDocument();
        expect(screen.queryByTestId('attention-list-count')).not.toBeInTheDocument();
    });

    it('a list still in flight says so — not that the read failed', () => {
        renderList({ attention: null, items: null, failed: false });
        const line = screen.getByTestId('attention-list-unavailable');
        expect(line.textContent).toBe('Reading what needs attention…');
        expect(line.textContent).not.toMatch(/Could not read/);
        expect(screen.queryByTestId('attention-list-rows')).not.toBeInTheDocument();
    });

    it('an empty list says every check passes', () => {
        renderList({ attention: { items: [], total: 0 }, items: [] });
        expect(screen.getByTestId('attention-list-empty')).toBeInTheDocument();
        expect(screen.queryByTestId('attention-list-row')).not.toBeInTheDocument();
    });

    it('a navigate action inside the hub goes through navigate(section)', async () => {
        const { navigate, onNavigate, user } = renderList();
        const rows = screen.getAllByTestId('attention-list-row');
        await user.click(within(rows[0]).getByTestId('attention-list-row-action'));
        expect(navigate).toHaveBeenCalledWith('settings', undefined, undefined); // (section, id, tab)
        expect(onNavigate).not.toHaveBeenCalled();
    });

    it('an action that leaves the hub goes to the host callback', async () => {
        const { navigate, onNavigate, user } = renderList();
        const rows = screen.getAllByTestId('attention-list-row');
        await user.click(within(rows[2]).getByTestId('attention-list-row-action'));
        expect(onNavigate).toHaveBeenCalledWith('admin/security/guardrails');
        expect(navigate).not.toHaveBeenCalled();
    });

    it('an auto-fix confirms before it runs, and cancel leaves nothing behind', async () => {
        const { onAutoFix, user } = renderList();
        const rows = screen.getAllByTestId('attention-list-row');
        await user.click(within(rows[1]).getByTestId('attention-list-row-action'));
        expect(onAutoFix).not.toHaveBeenCalled();
        await user.click(screen.getByTestId('attention-list-row-confirm-no'));
        expect(onAutoFix).not.toHaveBeenCalled();
        await user.click(within(screen.getAllByTestId('attention-list-row')[1]).getByTestId('attention-list-row-action'));
        await user.click(screen.getByTestId('attention-list-row-confirm-yes'));
        expect(onAutoFix).toHaveBeenCalledWith('AIA-Art50-marking');
    });

    it('labels an auto-fix with its count', () => {
        renderList();
        const rows = screen.getAllByTestId('attention-list-row');
        expect(within(rows[1]).getByTestId('attention-list-row-action').textContent).toContain('Auto-fix · 2');
    });

    it('uses tone tokens, never a hex', () => {
        const { container } = renderList();
        expect(container.innerHTML).not.toMatch(/#[0-9a-fA-F]{6}\b/);
    });
});

describe('AttentionList — the whole list in one place', () => {
    it('shows five rows, then "Show all {n}" expands every item inline and "Show fewer" folds it back', async () => {
        const { navigate, user } = renderList({ attention: { items: MANY, total: 12 }, items: MANY });
        expect(screen.getAllByTestId('attention-list-row')).toHaveLength(5);
        const toggle = screen.getByTestId('attention-list-toggle');
        expect(toggle).toHaveTextContent('Show all 12');
        expect(toggle).toHaveAttribute('aria-expanded', 'false');
        expect(toggle).toHaveAttribute('aria-controls', screen.getByTestId('attention-list-rows').id);

        await user.click(toggle);
        const rows = screen.getAllByTestId('attention-list-row');
        expect(rows).toHaveLength(12);
        expect(toggle).toHaveTextContent('Show fewer');
        expect(toggle).toHaveAttribute('aria-expanded', 'true');
        // Every expanded row keeps its own action — the list never sends you elsewhere to act.
        await user.click(within(rows[11]).getByTestId('attention-list-row-action'));
        expect(navigate).toHaveBeenCalledWith('ropa', undefined, undefined);

        await user.click(toggle);
        expect(screen.getAllByTestId('attention-list-row')).toHaveLength(5);
        // No link that only opens the first item's framework.
        expect(screen.queryByTestId('attention-list-all')).toBeNull();
        expect(screen.queryByTestId('attention-list-view-all')).toBeNull();
    });

    it('has no toggle when everything fits', () => {
        renderList();
        expect(screen.queryByTestId('attention-list-toggle')).toBeNull();
        expect(screen.queryByTestId('attention-list-elsewhere')).toBeNull();
    });

    it('names the items the server did not send at the end of the expanded list', async () => {
        const { user } = renderList({ attention: { items: MANY, total: 61 }, items: MANY });
        expect(screen.queryByTestId('attention-list-elsewhere')).toBeNull();
        await user.click(screen.getByTestId('attention-list-toggle'));
        expect(screen.getByTestId('attention-list-elsewhere')).toHaveTextContent('49 more on the framework pages');
    });

    it('limit still caps the folded list', () => {
        renderList({ limit: 2 });
        expect(screen.getAllByTestId('attention-list-row')).toHaveLength(2);
        expect(screen.getByTestId('attention-list-toggle')).toHaveTextContent('Show all 4');
    });
});

describe('AttentionList — the meta line', () => {
    const metaText = (row) => within(row).getByTestId('attention-list-row-meta').textContent;

    it('puts separators only between parts: a register item (no verification kind) has no dangling dot', () => {
        const items = [
            { id: 'register:obligation:3', code: 'obligation_overdue', title: 'Overdue: Phishing simulation', status: 'fail',
                meta: { severity: 'high', verification: 'register', detail: 'Due 2026-10-03.', frameworks: [{ regulation: 'ISO27001', ref: 'cl. 9' }] },
                action: { type: 'navigate', target: '/app/admin/compliance/training' } },
            { id: 'register:no-refs', code: 'x', title: 'No references', status: 'warn',
                meta: { severity: 'medium', verification: 'automated', frameworks: [] }, action: null },
        ];
        renderList({ attention: { items, total: 2 }, items });
        const rows = screen.getAllByTestId('attention-list-row');
        const first = metaText(rows[0]);
        expect(first).toBe('ISO cl. 9·Should fix');
        expect(within(rows[0]).queryByTestId('verification-chip')).toBeNull();
        // No leading dot when the refs are missing.
        expect(metaText(rows[1])).toMatch(/^Consider·/);
        for (const row of rows) {
            const text = metaText(row);
            expect(text).not.toMatch(/^·|·$|··/);
        }
    });

    it('caps the references at two and keeps the rest in the title', () => {
        const items = [{
            id: 'check:supplier', code: 'ISO-A.5.20', title: 'Supplier and cloud service agreements', status: 'fail',
            meta: { severity: 'high', verification: 'automated', frameworks: [
                { regulation: 'ISO27001', ref: 'A.5.20' }, { regulation: 'ISO27001', ref: 'A.5.22' }, { regulation: 'ISO27001', ref: 'A.5.23' },
                { regulation: 'NIS2', ref: 'Art. 21(2)(d)' }, { regulation: 'DORA', ref: 'Art. 28(3)' },
            ] },
            action: { type: 'open_fix', target: 'admin/compliance/settings' },
        }];
        renderList({ attention: { items, total: 1 }, items });
        const ref = screen.getByTestId('article-ref');
        expect(ref).toHaveAttribute('title', expect.stringContaining('DORA Art. 28(3)'));
        expect(screen.getByTestId('article-ref-more')).toHaveTextContent('+3');
    });

    it('a neutral severity word: the glyph already carries the colour', () => {
        renderList();
        const tag = within(screen.getAllByTestId('attention-list-row')[0]).getByTestId('severity-tag');
        expect(tag).toHaveAttribute('data-tone', 'neutral');
    });

    it('the detail sits on its own line, without a leading dot', () => {
        renderList();
        const row = screen.getAllByTestId('attention-list-row')[0];
        const detail = within(row).getByTestId('attention-list-row-detail');
        expect(detail).toHaveTextContent('URL missing in Settings');
        expect(detail.textContent.startsWith('·')).toBe(false);
        expect(metaText(row)).not.toContain('URL missing');
    });
});

describe('AttentionList — collapsed per-source findings', () => {
    it('says how many subjects a collapsed item is about, and opens a single subject', async () => {
        const { default: userEvent } = await import('@testing-library/user-event');
        const onNavigate = vi.fn();
        const items = [
            {
                id: 'check:GDPR-Art30-project-personal-data:subjects', code: 'GDPR-Art30-project-personal-data', title: 'Projects with personal data have a processing record', status: 'warn',
                meta: { severity: 'medium', subject_count: 4, detail: '4 projects need attention.', frameworks: [{ regulation: 'GDPR', ref: '30' }] },
                action: { type: 'open_fix', target: '/app/admin/compliance/ropa' },
            },
            {
                id: 'check:GDPR-Art5-1-e-project-retention:project:p1', code: 'GDPR-Art5-1-e-project-retention', title: 'Unused projects', status: 'warn',
                meta: { severity: 'medium', link: '/app/projects/p1/settings', frameworks: [{ regulation: 'GDPR', ref: '5(1)(e)' }] },
                action: { type: 'open_fix', target: '/app/admin/compliance/settings' },
            },
        ];
        render(<AttentionList attention={{ items, total: 2, tail: [] }} items={items} navigate={vi.fn()} onNavigate={onNavigate} />);
        const rows = screen.getAllByTestId('attention-list-row');
        expect(within(rows[0]).getByTestId('attention-list-row-affected')).toHaveTextContent('4 affected');
        expect(within(rows[0]).queryByTestId('attention-list-row-open-subject')).toBeNull();
        await userEvent.setup().click(within(rows[1]).getByTestId('attention-list-row-open-subject'));
        expect(onNavigate).toHaveBeenCalledWith('projects/p1/settings');
    });
});

describe('AttentionList — targets that carry a tab are live clicks', () => {
    it('opens the tab the target names, and sends a moved tab where it went', async () => {
        const { default: userEvent } = await import('@testing-library/user-event');
        const user = userEvent.setup();
        const navigate = vi.fn();
        const items = [
            { id: 'register:ai_act:agent:a1', code: 'ai_act_attestation_expired', title: 'AI Act self-assessment expired (agent)', status: 'warn',
                meta: { frameworks: [{ regulation: 'AIA', ref: 'Art. 6' }] },
                action: { type: 'navigate', target: '/app/admin/compliance/frameworks?tab=per_automation' } },
            { id: 'register:obligation:3', code: 'obligation_overdue', title: 'Overdue: Internal audit', status: 'fail',
                meta: { frameworks: [{ regulation: 'ISO27001', ref: 'cl. 9' }] },
                action: { type: 'navigate', target: '/app/admin/compliance/audits?tab=obligations' } },
        ];
        render(<AttentionList attention={{ items, total: 2, tail: [] }} items={items} navigate={navigate} onNavigate={vi.fn()} />);
        const rows = screen.getAllByTestId('attention-list-row');
        await user.click(within(rows[0]).getByTestId('attention-list-row-action'));
        // More frameworks › Per automation moved to AI Act › Systems (sections.js legacyTabs).
        expect(navigate).toHaveBeenLastCalledWith('aia', undefined, 'systems');
        await user.click(within(rows[1]).getByTestId('attention-list-row-action'));
        expect(navigate).toHaveBeenLastCalledWith('training', undefined, undefined);
    });
});
