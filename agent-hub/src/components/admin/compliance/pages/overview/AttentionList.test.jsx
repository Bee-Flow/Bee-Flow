import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
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

const ATTENTION = {
    items: ITEMS, total: 7,
    tail: [{ id: 't1', title: 'DLP partly active', status: 'warn' }],
    warn_tail_count: 2,
};

function renderList(props = {}) {
    const navigate = vi.fn();
    const onNavigate = vi.fn();
    const onAutoFix = vi.fn();
    const utils = render(
        <AttentionList attention={ATTENTION} items={ITEMS} navigate={navigate} onNavigate={onNavigate} onAutoFix={onAutoFix} {...props} />,
    );
    return { ...utils, navigate, onNavigate, onAutoFix };
}

describe('AttentionList', () => {
    it('renders the rows with glyph, refs, severity and verification', () => {
        renderList();
        const rows = screen.getAllByTestId('attention-list-row');
        expect(rows).toHaveLength(4);
        expect(rows[0].dataset.status).toBe('fail');
        expect(rows[0].textContent).toContain('GDPR Art. 12');
        expect(rows[0].textContent).toContain('URL missing in Settings');
        expect(screen.getByTestId('attention-list-count').textContent).toBe('7');
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

    it('a navigate action inside the hub goes through navigate(section)', () => {
        const { navigate, onNavigate } = renderList();
        const rows = screen.getAllByTestId('attention-list-row');
        fireEvent.click(within(rows[0]).getByTestId('attention-list-row-action'));
        expect(navigate).toHaveBeenCalledWith('settings', undefined);
        expect(onNavigate).not.toHaveBeenCalled();
    });

    it('an action that leaves the hub goes to the host callback', () => {
        const { navigate, onNavigate } = renderList();
        const rows = screen.getAllByTestId('attention-list-row');
        fireEvent.click(within(rows[2]).getByTestId('attention-list-row-action'));
        expect(onNavigate).toHaveBeenCalledWith('admin/security/guardrails');
        expect(navigate).not.toHaveBeenCalled();
    });

    it('an auto-fix confirms before it runs, and cancel leaves nothing behind', () => {
        const { onAutoFix } = renderList();
        const rows = screen.getAllByTestId('attention-list-row');
        fireEvent.click(within(rows[1]).getByTestId('attention-list-row-action'));
        expect(onAutoFix).not.toHaveBeenCalled();
        fireEvent.click(screen.getByTestId('attention-list-row-confirm-no'));
        expect(onAutoFix).not.toHaveBeenCalled();
        fireEvent.click(within(screen.getAllByTestId('attention-list-row')[1]).getByTestId('attention-list-row-action'));
        fireEvent.click(screen.getByTestId('attention-list-row-confirm-yes'));
        expect(onAutoFix).toHaveBeenCalledWith('AIA-Art50-marking');
    });

    it('labels an auto-fix with its count', () => {
        renderList();
        const rows = screen.getAllByTestId('attention-list-row');
        expect(within(rows[1]).getByTestId('attention-list-row-action').textContent).toContain('Auto-fix · 2');
    });

    it('caps the list and names the rest in the footer', () => {
        renderList({ limit: 2 });
        expect(screen.getAllByTestId('attention-list-row')).toHaveLength(2);
        const more = screen.getByTestId('attention-list-more');
        expect(more.textContent).toContain('DLP partly active');
        expect(screen.getByTestId('attention-list-view-all')).toBeInTheDocument();
    });

    it('"View all" lands on the section of the first row', () => {
        const { navigate } = renderList({ limit: 2 });
        fireEvent.click(screen.getByTestId('attention-list-view-all'));
        expect(navigate).toHaveBeenCalledWith('settings');
    });

    it('uses tone tokens, never a hex', () => {
        const { container } = renderList();
        expect(container.innerHTML).not.toMatch(/#[0-9a-fA-F]{6}\b/);
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
