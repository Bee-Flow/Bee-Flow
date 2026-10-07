import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { metaFor, subjectOf, detailOf, actionLabel, humanizeAction } from './accessAuditLabels';
import AccessAuditPage from './AccessAuditPage';

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

const DSR_VIEWED = {
    id: '3',
    action: 'dsr.subject_viewed',
    target_type: 'dsr_request',
    target_id: 'dsr_2417',
    changed_by: 'u_marieke',
    created_at: '2026-10-06T21:16:45Z',
    new_values: { reason: 'handling the request' },
};

const USERS = [
    { id: 'u_marieke', displayName: 'Marieke de Wit', email: 'm.dewit@example.test' },
    { id: 'usr_owner', displayName: 'Joost Mulder', email: 'j.mulder@example.test' },
];

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
            orgUsers: USERS,
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

    it('filtering goes to the server, not to the rendered page', async () => {
        const user = userEvent.setup();
        const setFilter = vi.fn();
        render(<AccessAuditPage {...props({ entries: [FAILED_UNKNOWN, PUBLIC_URL], hook: { setFilter } })} />);
        await user.click(screen.getByTestId('access-audit-pill-login_failed'));
        expect(setFilter).toHaveBeenCalledWith({ action: 'login_failed' });
        // And nothing was filtered locally in the meantime.
        expect(screen.getByText('Public URL created')).toBeTruthy();
    });

    it('the date and account filters also go to the server; the account is picked by name', async () => {
        const user = userEvent.setup();
        const setFilter = vi.fn();
        render(<AccessAuditPage {...props({ entries: [FAILED_UNKNOWN], hook: { setFilter } })} />);
        await user.click(screen.getByTestId('access-audit-filters-toggle'));
        await user.type(screen.getByTestId('access-audit-since'), '2026-09-01');
        expect(setFilter).toHaveBeenCalledWith({ since: '2026-09-01' });
        const actor = screen.getByTestId('access-audit-actor');
        expect(within(actor).getByRole('option', { name: /Marieke de Wit/ })).toBeTruthy();
        await user.selectOptions(actor, 'u_marieke');
        expect(setFilter).toHaveBeenCalledWith({ actor: 'u_marieke' });
        await user.click(screen.getByTestId('access-audit-clear'));
        expect(setFilter).toHaveBeenCalledWith({});
    });

    it('an account filter on a former member stays selected', async () => {
        const user = userEvent.setup();
        render(<AccessAuditPage {...props({ entries: [FAILED_UNKNOWN], hook: { filter: { actor: 'usr_gone' } } })} />);
        await user.click(screen.getByTestId('access-audit-filters-toggle'));
        expect(screen.getByTestId('access-audit-actor').value).toBe('usr_gone');
    });

    it('an actor the log names but the roster does not (a former member, the platform) can be filtered on', async () => {
        const user = userEvent.setup();
        const setFilter = vi.fn();
        const gone = { ...DSR_VIEWED, id: '7', changed_by: 'usr_gone' };
        const system = { ...PUBLIC_URL, id: '8', changed_by: 'system' };
        render(<AccessAuditPage {...props({ entries: [gone, system, FAILED_UNKNOWN], hook: { setFilter } })} />);
        await user.click(screen.getByTestId('access-audit-filters-toggle'));
        const actor = screen.getByTestId('access-audit-actor');
        expect(within(actor).getByRole('option', { name: 'usr_gone' })).toBeTruthy();
        expect(within(actor).getByRole('option', { name: 'System' })).toBeTruthy();
        // Nobody (a sign-in without an account) is not an account to pick.
        expect(within(actor).queryByRole('option', { name: 'anonymous' })).toBeNull();
        await user.selectOptions(actor, 'usr_gone');
        expect(setFilter).toHaveBeenCalledWith({ actor: 'usr_gone' });
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

    it('paging asks the server for the next offset', async () => {
        const user = userEvent.setup();
        const setOffset = vi.fn();
        render(<AccessAuditPage {...props({ entries: [FAILED_UNKNOWN], extra: { total: 250, limit: 100, offset: 0 }, hook: { setOffset } })} />);
        await user.click(screen.getByTestId('access-audit-pager-next'));
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

    it('an unknown action reads as words, never as its raw key', () => {
        const meta = metaFor('something_new');
        expect(meta.key).toBeNull();
        expect(meta.en).toBe('Something new');
        expect(humanizeAction('dsr.subject_reidentified')).toBe('Subject reidentified');
        expect(humanizeAction('')).toBe('—');
        expect(subjectOf({ target_type: 'other', target_id: 'x1' }, (k, f) => f)).toBe('x1');
    });

    it('the data-subject request events have their own words', () => {
        const t = (k, f) => f;
        expect(actionLabel('dsr.subject_viewed', t)).toBe('Request opened');
        expect(actionLabel('dsr.discovery_run', t)).toBe('Data search run');
        expect(actionLabel('dsr.dossier_exported', t)).toBe('Dossier exported');
    });

    it('a request row reads "Request opened · Request #2417 · by Marieke de Wit", with no raw key or id', () => {
        render(<AccessAuditPage {...props({ entries: [DSR_VIEWED] })} />);
        const row = screen.getByTestId('access-audit-row-3');
        expect(row.textContent).toContain('Request opened');
        expect(row.textContent).toContain('Request #2417');
        expect(screen.getByTestId('access-audit-actor-3').textContent).toBe('Marieke de Wit');
        // The id stays reachable, in the tooltip.
        expect(screen.getByTestId('access-audit-actor-3').getAttribute('title')).toBe('u_marieke');
        // The folded-column line under the subject names the actor too.
        expect(row.textContent).toContain('by Marieke de Wit');
        expect(row.textContent).not.toMatch(/dsr\.|dsr_2417|u_marieke/);
    });

    it('the detail repeats under the subject while the Detail column is folded, and only then', () => {
        render(<AccessAuditPage {...props({ entries: [FAILED_UNKNOWN, PUBLIC_URL] })} />);
        const folded = screen.getByTestId('access-audit-folded-detail-1');
        expect(folded.textContent).toBe('password · invalid_credentials · 203.0.113.9 · same-name tag d6e7f8');
        expect(folded.className).toContain('@max-[1180px]/ctable:inline');
        // A row without a detail adds no empty line.
        expect(screen.queryByTestId('access-audit-folded-detail-2')).toBeNull();
    });

    it('"Request #2417" opens that request', async () => {
        const user = userEvent.setup();
        const navigate = vi.fn();
        render(<AccessAuditPage {...props({ entries: [DSR_VIEWED], navigate })} />);
        await user.click(screen.getByRole('button', { name: 'Request #2417' }));
        expect(navigate).toHaveBeenCalledWith('dsr', 'dsr_2417');
    });

    it('an actor the roster does not know keeps the id; nobody and the platform read as such', () => {
        render(<AccessAuditPage {...props({ entries: [
            { ...PUBLIC_URL, id: '4', changed_by: 'usr_gone' },
            { ...PUBLIC_URL, id: '5', changed_by: 'system' },
            FAILED_UNKNOWN,
        ] })} />);
        expect(screen.getByTestId('access-audit-actor-4').textContent).toBe('usr_gone');
        expect(screen.getByTestId('access-audit-actor-5').textContent).toBe('System');
        expect(screen.getByTestId('access-audit-actor-1').textContent).toBe('—');
    });

    it('filter entries may be bare action strings: no crash, and words on the pills', () => {
        render(<AccessAuditPage {...props({ entries: [DSR_VIEWED], hook: { actions: ['dsr.subject_viewed', 'login_succeeded', '', null, { action: 'dsr.discovery_run', count: 2 }] } })} />);
        expect(screen.getByTestId('access-audit-pill-dsr.subject_viewed').textContent).toContain('Request opened');
        expect(screen.getByTestId('access-audit-pill-login_succeeded').textContent).toContain('Signed in');
        expect(screen.getByTestId('access-audit-pill-dsr.discovery_run').textContent).toContain('Data search run');
        expect(document.body.textContent).not.toContain('dsr.');
    });

    it('a phone card names the actor', () => {
        render(<AccessAuditPage {...props({ entries: [DSR_VIEWED], isMobile: true })} />);
        const card = screen.getByTestId('access-audit-card-3');
        expect(card.textContent).toContain('by Marieke de Wit');
        expect(card.className).not.toMatch(/\bpx-|\bpy-/);
    });
});
