import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import AccessAuditPage, { metaFor, subjectOf, detailOf } from './AccessAuditPage';

// t(key, fallback, params) — the real signature. Returning the rendered
// FALLBACK rather than the key is deliberate here: the redaction tests below
// are about what a row does and does not say to a person reading it, and a
// screen full of dotted key names cannot answer that.
vi.mock('../../../../hooks/useTranslation', () => {
    const useTranslation = () => ({
        t: (key, fallback, params) => {
            let out = typeof fallback === 'string' ? fallback : key;
            for (const [k, v] of Object.entries(params || {})) out = out.split(`{${k}}`).join(String(v));
            return out;
        },
        locale: 'en',
        resolvedLocale: 'en',
    });
    return { default: useTranslation, useTranslation };
});

const FAILED_UNKNOWN = {
    id: '1',
    action: 'login_failed',
    target_type: 'login_identifier',
    target_id: 'v1:9a3f2c1d',
    changed_by: 'anonymous',
    created_at: '2026-09-05T09:15:22Z',
    new_values: {
        method: 'password',
        reason: 'invalid_credentials',
        knownAccount: false,
        identifierFingerprint: 'v1:9a3f2c1d4b5e6f708192a3b4c5d6e7f8',
        ip: '203.0.113.9',
    },
};

const PUBLIC_URL = {
    id: '2',
    action: 'studio_app_public_page_created',
    target_type: 'studio_app',
    target_id: 'app_1',
    changed_by: 'usr_owner',
    created_at: '2026-09-05T10:00:00Z',
    new_values: { appName: 'Expense claims', tokenPrefix: 'pub_9f…', reachableWithoutAccount: true },
};

function props({ entries, extra = {}, hook = {}, ...rest } = {}) {
    return {
        section: { id: 'access_audit' }, tab: null, onTab: vi.fn(), navigate: vi.fn(), focusId: null,
        exportsEnabled: true, dl: (u) => u, api: '/api/compliance', isMobile: false, setHeaderActions: vi.fn(),
        data: {
            accessAudit: {
                data: entries === undefined ? null : { entries, total: entries?.length ?? 0, limit: 100, offset: 0, ...extra },
                actions: [{ action: 'login_failed', count: 3 }, { action: 'login_succeeded', count: 12 }],
                filter: {},
                offset: 0,
                exportError: null,
                setFilter: vi.fn(),
                setOffset: vi.fn(),
                exportUrl: '/api/compliance/access-audit/export?',
                ...hook,
            },
        },
        ...rest,
    };
}

describe('AccessAuditPage', () => {
    beforeEach(cleanup);

    it('a refused sign-in never shows what was typed', () => {
        render(<AccessAuditPage {...props({ entries: [FAILED_UNKNOWN] })} />);
        expect(screen.getByText('an account name that matched nothing')).toBeTruthy();
        expect(document.body.textContent).not.toContain('v1:9a3f2c1d4b');
        // The tag is a correlation handle, deliberately short and at the end.
        expect(document.body.textContent).toContain('same-name tag');
    });

    it('a public URL reads as an event, not as a row id', () => {
        render(<AccessAuditPage {...props({ entries: [PUBLIC_URL] })} />);
        expect(screen.getByText('Public URL created')).toBeTruthy();
        expect(screen.getByText('Expense claims')).toBeTruthy();
        expect(document.body.textContent).not.toContain('app_1');
    });

    it('filtering goes to the server, not to the rendered page', () => {
        const setFilter = vi.fn();
        render(<AccessAuditPage {...props({ entries: [FAILED_UNKNOWN, PUBLIC_URL], hook: { setFilter } })} />);
        fireEvent.click(screen.getByTestId('access-audit-pill-login_failed'));
        expect(setFilter).toHaveBeenCalledWith({ action: 'login_failed' });
        // And nothing was filtered locally in the meantime.
        expect(screen.getByText('Public URL created')).toBeTruthy();
    });

    it('the date and account filters also go to the server', () => {
        const setFilter = vi.fn();
        render(<AccessAuditPage {...props({ entries: [FAILED_UNKNOWN], hook: { setFilter } })} />);
        fireEvent.click(screen.getByTestId('access-audit-filters-toggle'));
        fireEvent.change(screen.getByTestId('access-audit-since'), { target: { value: '2026-09-01' } });
        expect(setFilter).toHaveBeenCalledWith({ since: '2026-09-01' });
        fireEvent.change(screen.getByTestId('access-audit-actor'), { target: { value: 'usr_1' } });
        expect(setFilter).toHaveBeenCalledWith({ actor: 'usr_1' });
        fireEvent.click(screen.getByTestId('access-audit-clear'));
        expect(setFilter).toHaveBeenCalledWith({});
    });

    it('the filter list is what the log holds, with counts', () => {
        render(<AccessAuditPage {...props({ entries: [FAILED_UNKNOWN] })} />);
        const refused = screen.getByTestId('access-audit-pill-login_failed');
        expect(refused.textContent).toContain('Sign-in refused');
        expect(refused.textContent).toContain('3');
        expect(screen.getByTestId('access-audit-pill-login_succeeded').textContent).toContain('12');
    });

    it('an unreadable log is not an empty one', () => {
        render(<AccessAuditPage {...props({ entries: [], extra: {} })} data={{ accessAudit: { data: { error: 'boom' }, actions: [], filter: {}, setFilter: vi.fn(), setOffset: vi.fn() } }} />);
        expect(screen.getByText('The access log could not be read')).toBeTruthy();
        expect(screen.queryByText('No events in this range')).toBeNull();
        expect(screen.queryByTestId('access-audit-table')).toBeNull();
    });

    it('an empty range says what an empty log would mean', () => {
        render(<AccessAuditPage {...props({ entries: [] })} />);
        expect(document.body.textContent).toContain('No events in this range');
        expect(document.body.textContent).toContain('not reaching the database');
    });

    it('a still-loading log is neither empty nor broken', () => {
        render(<AccessAuditPage {...props({ entries: undefined })} />);
        expect(screen.queryByText('No events in this range')).toBeNull();
        expect(screen.queryByText('The access log could not be read')).toBeNull();
        expect(screen.getAllByTestId('table-skeleton-row').length).toBeGreaterThan(0);
    });

    it('no export link is offered when the download url is withheld', () => {
        // The public demo: a plain <a download> is a browser navigation the demo
        // transport cannot stand in for, so the affordance is hidden rather than
        // handing a visitor a 401 page.
        const { container } = render(<AccessAuditPage {...props({ entries: [PUBLIC_URL] })} dl={() => null} />);
        expect(container.querySelector('a[download]')).toBeNull();
        expect(screen.queryByTestId('access-audit-export')).toBeNull();
    });

    it('no export link when exports are disabled for this host', () => {
        const { container } = render(<AccessAuditPage {...props({ entries: [PUBLIC_URL] })} exportsEnabled={false} />);
        expect(container.querySelector('a[download]')).toBeNull();
    });

    it('offers the export on the filtered query when the url survives dl()', () => {
        render(<AccessAuditPage {...props({ entries: [PUBLIC_URL] })} />);
        expect(screen.getByTestId('access-audit-export').getAttribute('href')).toBe('/api/compliance/access-audit/export?');
    });

    it('paging asks the server for the next offset', () => {
        const setOffset = vi.fn();
        render(<AccessAuditPage {...props({ entries: [FAILED_UNKNOWN], extra: { total: 250, limit: 100, offset: 0 }, hook: { setOffset } })} />);
        fireEvent.click(screen.getByTestId('access-audit-pager-next'));
        expect(setOffset).toHaveBeenCalledWith(100);
    });

    it('an export error is shown on its own, without blanking the log', () => {
        render(<AccessAuditPage {...props({ entries: [PUBLIC_URL], hook: { exportError: 'Export refused' } })} />);
        expect(screen.getByTestId('access-audit-export-error').textContent).toContain('Export refused');
        expect(screen.getByTestId('access-audit-table')).toBeTruthy();
    });

    it('detailOf builds the line from an allow-list, never from the whole payload', () => {
        const t = (key, fallback, params) => {
            let out = typeof fallback === 'string' ? fallback : key;
            for (const [k, v] of Object.entries(params || {})) out = out.split(`{${k}}`).join(String(v));
            return out;
        };
        const line = detailOf({ new_values: { method: 'password', secret: 'hunter2', identifierFingerprint: 'v1:abcdef123456' } }, t);
        expect(line).toContain('password');
        expect(line).not.toContain('hunter2');
        expect(line).toContain('123456');
        expect(line).not.toContain('v1:abcdef');
        expect(detailOf({}, t)).toBe('—');
    });

    it('an unknown action still renders as itself', () => {
        const meta = metaFor('something_new');
        expect(meta.key).toBeNull();
        expect(meta.en).toBe('something_new');
        expect(subjectOf({ target_type: 'other', target_id: 'x1' }, (k, f) => f)).toBe('x1');
    });
});
