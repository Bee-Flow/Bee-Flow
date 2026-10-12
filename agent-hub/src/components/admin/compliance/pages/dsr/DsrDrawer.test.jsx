import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DsrDrawer, { discoveryChips, readDiscovery } from './DsrDrawer';
import { actorName, fallbackTimeline, normaliseTimelineRow } from './dsrTimeline';
import { DAY_MS } from '../../../../shared/deadlineMath';

/**
 * Artboard 1c's drawer: the actions post the right bodies, the address stays
 * masked, a closed request opens read-only, and the two lazy sections
 * (timeline / found in Bee Flow) degrade when the routes are not there.
 */

vi.mock('../../../../../hooks/useTranslation', () => {
    const useTranslation = () => ({
        t: (key, fallback, vars) => {
            const base = typeof fallback === 'string' ? fallback : key;
            const params = typeof fallback === 'string' ? vars : fallback;
            return params ? Object.entries(params).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), base) : base;
        },
        locale: 'en',
        resolvedLocale: 'en',
    });
    return { default: useTranslation, useTranslation };
});

const NOW = new Date('2026-09-14T09:12:00Z').getTime();
const iso = (ms) => new Date(ms).toISOString();
const t = (key, fallback, vars) => (vars ? Object.entries(vars).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), fallback) : fallback);

const OPEN = {
    id: 2038, request_type: 'deletion', status: 'in_progress', subject_email: 'john.doe@gmail.com',
    channel: 'public_form', identity_status: 'verified_email_link',
    created_at: iso(NOW - 33 * DAY_MS), started_at: iso(NOW - 25 * DAY_MS), started_by_name: 'T. Smit', notes: 'Please delete everything.',
};
const PENDING = { id: 2044, request_type: 'portability', status: 'pending', subject_email: 'anna@vandijkgroep.nl', channel: 'form', created_at: iso(NOW - DAY_MS) };
const EXTENDED = { ...OPEN, id: 2039, extended_until: iso(NOW + 40 * DAY_MS), due_at: iso(NOW + 40 * DAY_MS) };
const DONE = { id: 2036, request_type: 'access', status: 'fulfilled', subject_email: 'p.q@outlook.com', channel: 'phone', created_at: iso(NOW - 48 * DAY_MS), completed_at: iso(NOW - 39 * DAY_MS), result_summary: 'Export e-mailed 21 Aug' };
// Exactly as GET /api/dsr/requests sends it: `state` is the CLOCK, `status` the lifecycle.
const REJECTED = { id: 2414, request_type: 'portability', status: 'rejected', state: 'none', subject_email_masked: 'b.•••@example.com', channel: 'email_dpo', identity_status: 'unverified', created_at: iso(NOW - 48 * DAY_MS), due_at: iso(NOW - 18 * DAY_MS), fulfilled_at: iso(NOW - 40 * DAY_MS), result_summary: 'Rejected under Art. 12(6).' };
const ORG_USERS = [{ id: 'u_marieke', displayName: 'Marieke de Wit', email: 'm.dewit@example.org' }];

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });

function renderDrawer(props) {
    const handlers = { onClose: vi.fn(), onFulfil: vi.fn(), onReject: vi.fn(), onExtend: vi.fn(), onStart: vi.fn(), onVerifyIdentity: vi.fn() };
    const utils = render(<DsrDrawer open request={OPEN} exportUrl="/api/dsr/requests/2038/export" {...handlers} {...props} />);
    return { ...utils, ...handlers };
}

describe('DsrDrawer — header, clock, data subject', () => {
    it('renders nothing when closed or without a request', () => {
        const { container, rerender } = render(<DsrDrawer open={false} request={OPEN} />);
        expect(container).toBeEmptyDOMElement();
        rerender(<DsrDrawer open request={null} />);
        expect(container).toBeEmptyDOMElement();
    });

    it('header = #id · type · "Art. n · via channel"; the clock block says overdue; the meta line has received/due/not extended', () => {
        renderDrawer();
        const drawer = screen.getByTestId('dsr-drawer');
        expect(drawer).toHaveAttribute('data-mode', 'inline');
        const header = screen.getByTestId('dsr-drawer-header');
        expect(header).toHaveTextContent('#2038');
        expect(header).toHaveTextContent('Deletion request');
        expect(header).toHaveTextContent('Art. 17 · via Form /dsr');
        const clock = screen.getByTestId('dsr-drawer-clock');
        expect(clock).toHaveAttribute('data-state', 'overdue');
        // No server due_at: receipt + one calendar month (Art. 12(3)), 12 Aug → 12 Sep, not + 30 days.
        expect(clock).toHaveTextContent('overdue by 2 days');
        expect(clock).toHaveTextContent(/Received 12 Aug \d{2}:\d{2} · due 12 Sep \d{2}:\d{2} · not extended/);
    });

    it('the address is masked, identity reads "confirmed via e-mail link", the DPO note is there, and the full address is nowhere', () => {
        const { container } = renderDrawer();
        expect(screen.getByTestId('dsr-drawer-email')).toHaveTextContent('j.•••@gmail.com');
        expect(container.textContent).not.toContain('john.doe@gmail.com');
        expect(screen.getByTestId('dsr-drawer-identity')).toHaveAttribute('data-identity', 'verified_link');
        expect(screen.getByTestId('dsr-drawer-identity')).toHaveTextContent('identity confirmed via e-mail link');
        expect(screen.getByTestId('dsr-drawer-identity').className).toContain('text-[var(--success-ink)]');
        expect(screen.getByTestId('dsr-drawer-subject')).toHaveTextContent('visible only to the DPO and the handler');
        expect(screen.getByTestId('dsr-drawer-notes')).toHaveTextContent('Please delete everything.');
    });

    it('an open request with an unconfirmed identity offers "Confirm identity…", which asks how it was checked and posts it', async () => {
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        const { onVerifyIdentity } = renderDrawer({ request: PENDING });
        const chip = screen.getByTestId('dsr-drawer-identity');
        expect(chip).toHaveAttribute('data-identity', 'unknown');
        const confirm = screen.getByRole('button', { name: /Confirm identity…/ });
        expect(confirm).toHaveAccessibleName(/identity not yet confirmed/);
        expect(confirm).toHaveAttribute('aria-expanded', 'false');
        await user.click(confirm);
        expect(confirm).toHaveAttribute('aria-expanded', 'true');
        expect(screen.getByLabelText('How was the identity checked?')).toHaveFocus();
        const save = screen.getByTestId('dsr-drawer-identity-save');
        expect(save).toBeDisabled();
        await user.type(screen.getByLabelText('How was the identity checked?'), 'Passport checked at the front desk');
        await user.click(save);
        expect(onVerifyIdentity).toHaveBeenCalledWith({ method: 'manual', note: 'Passport checked at the front desk' });
        await waitFor(() => expect(screen.queryByTestId('dsr-drawer-identity-form')).toBeNull());
    });

    it('a closed request only reads its identity: no confirm button', () => {
        renderDrawer({ request: REJECTED });
        expect(screen.getByTestId('dsr-drawer-identity')).toHaveTextContent('identity not yet confirmed');
        expect(screen.queryByTestId('dsr-drawer-identity-confirm')).toBeNull();
    });
});

describe('DsrDrawer — actions post the right bodies', () => {
    it('Fulfil → { status:fulfilled, result_summary, notify_subject:true } with the typed summary', () => {
        const { onFulfil } = renderDrawer();
        fireEvent.change(screen.getByTestId('dsr-drawer-summary-input'), { target: { value: 'Deleted 2 memories, 6 rows anonymised.' } });
        fireEvent.click(screen.getByTestId('dsr-drawer-fulfil'));
        expect(onFulfil).toHaveBeenCalledWith({ status: 'fulfilled', result_summary: 'Deleted 2 memories, 6 rows anonymised.', notify_subject: true });
        expect(screen.getByTestId('dsr-drawer-fulfil').style.background).toBe('var(--accent-primary)');
    });

    it('Reject… opens an inline reason; confirm is disabled until typed; then { status:rejected, result_summary:reason }', () => {
        const { onReject } = renderDrawer();
        expect(screen.queryByTestId('dsr-drawer-reject-form')).toBeNull();
        fireEvent.click(screen.getByTestId('dsr-drawer-reject'));
        const confirm = screen.getByTestId('dsr-drawer-reject-confirm');
        expect(confirm).toBeDisabled();
        fireEvent.change(screen.getByTestId('dsr-drawer-reject-reason'), { target: { value: 'Manifestly unfounded' } });
        expect(confirm).not.toBeDisabled();
        fireEvent.click(confirm);
        expect(onReject).toHaveBeenCalledWith({ status: 'rejected', result_summary: 'Manifestly unfounded', notify_subject: true });
    });

    it('Extend +2 months asks for a reason and calls onExtend(reason); it is hidden once extended_until is set', () => {
        const { onExtend, rerender } = renderDrawer();
        fireEvent.click(screen.getByTestId('dsr-drawer-extend'));
        fireEvent.change(screen.getByTestId('dsr-drawer-extend-reason'), { target: { value: 'Complex request across three systems' } });
        fireEvent.click(screen.getByTestId('dsr-drawer-extend-confirm'));
        expect(onExtend).toHaveBeenCalledWith('Complex request across three systems');
        rerender(<DsrDrawer open request={EXTENDED} onExtend={onExtend} onFulfil={vi.fn()} onReject={vi.fn()} />);
        expect(screen.queryByTestId('dsr-drawer-extend')).toBeNull();
        expect(screen.getByTestId('dsr-drawer-clock')).toHaveTextContent(/extended to 24 Oct/);
    });

    it('a pending request offers Start; Export is a download link to the export url; the privacy note wears the kind colour', () => {
        const { onStart } = renderDrawer({ request: PENDING, exportUrl: '/api/dsr/requests/2044/export' });
        fireEvent.click(screen.getByTestId('dsr-drawer-start'));
        expect(onStart).toHaveBeenCalledTimes(1);
        const exp = screen.getByTestId('dsr-drawer-export');
        expect(exp).toHaveAttribute('href', '/api/dsr/requests/2044/export');
        expect(exp).toHaveAttribute('download');
        expect(screen.getByTestId('dsr-drawer-actions')).toHaveTextContent('Personal data leaves Bee Flow only by e-mail to the data subject');
    });

    it('without an export url (demo) there is no Export link; busy disables the actions', () => {
        renderDrawer({ exportUrl: null, busy: true });
        expect(screen.queryByTestId('dsr-drawer-export')).toBeNull();
        expect(screen.getByTestId('dsr-drawer-fulfil')).toBeDisabled();
        expect(screen.getByTestId('dsr-drawer-reject')).toBeDisabled();
    });

    it('Escape and the X close it', () => {
        const { onClose } = renderDrawer();
        fireEvent.click(screen.getByTestId('dsr-drawer-close'));
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(2);
    });
});

describe('DsrDrawer — a completed request is read-only', () => {
    it('no textarea, no fulfil/reject/extend/start; the summary is text; Export stays; the clock says completed in n days', () => {
        renderDrawer({ request: DONE, exportUrl: '/api/dsr/requests/2036/export' });
        expect(screen.queryByTestId('dsr-drawer-summary-input')).toBeNull();
        expect(screen.queryByTestId('dsr-drawer-fulfil')).toBeNull();
        expect(screen.queryByTestId('dsr-drawer-reject')).toBeNull();
        expect(screen.queryByTestId('dsr-drawer-extend')).toBeNull();
        expect(screen.queryByTestId('dsr-drawer-start')).toBeNull();
        expect(screen.getByTestId('dsr-drawer-summary-text')).toHaveTextContent('Export e-mailed 21 Aug');
        expect(screen.getByTestId('dsr-drawer-export')).toHaveAttribute('href', '/api/dsr/requests/2036/export');
        expect(screen.getByTestId('dsr-drawer-clock')).toHaveTextContent('completed in 9 days');
        expect(screen.getByTestId('dsr-drawer-clock')).toHaveAttribute('data-state', 'done');
    });

    it('a server-shaped rejected row ({status:"rejected", state:"none"}) is read-only too: Export only, never a second e-mail', () => {
        renderDrawer({ request: REJECTED, exportUrl: '/api/dsr/requests/2414/export' });
        expect(screen.getByTestId('dsr-drawer-body')).toHaveAttribute('data-readonly', 'true');
        for (const id of ['fulfil', 'reject', 'extend', 'start', 'summary-input']) {
            expect(screen.queryByTestId(`dsr-drawer-${id}`)).toBeNull();
        }
        expect(screen.getByTestId('dsr-drawer-export')).toHaveAttribute('href', '/api/dsr/requests/2414/export');
        expect(screen.getByTestId('dsr-drawer-clock')).toHaveAttribute('data-state', 'done');
        expect(screen.getByTestId('dsr-drawer-clock')).not.toHaveTextContent(/overdue/);
    });
});

describe('DsrDrawer — timeline and discovery degrade', () => {
    it('without loadTimeline the timeline is the facts we have: received (clock started), started by, deadline passed in error ink', () => {
        renderDrawer();
        const items = within(screen.getByTestId('dsr-drawer-timeline')).getAllByRole('listitem');
        expect(items.map(i => i.textContent)).toEqual([
            expect.stringMatching(/12 Aug \d{2}:\d{2}Received via Form \/dsr · clock started/),
            expect.stringMatching(/20 Aug \d{2}:\d{2}Started by T\. Smit/),
            expect.stringMatching(/12 Sep \d{2}:\d{2}Deadline passed/),
        ]);
        expect(items[2]).toHaveAttribute('data-tone', 'error');
        expect(items[2].className).toContain('text-[var(--error-ink)]');
    });

    it('a server timeline replaces the fallback; a failing loader (404) falls back; discovery renders chips or hides the section', async () => {
        const loadTimeline = vi.fn().mockResolvedValue([
            { at: iso(NOW - 33 * DAY_MS), kind: 'received', text: 'Received via /dsr · clock started' },
            { at: iso(NOW - 33 * DAY_MS + 60_000), kind: 'ack_sent', text: 'Acknowledgement e-mailed' },
            { at: iso(NOW - 3 * DAY_MS), kind: 'overdue', text: 'Deadline passed · DPO notified', by: 'u_marieke' },
        ]);
        const loadDiscovery = vi.fn().mockResolvedValue({
            sources: [
                { kind: 'memories', count: 2 },
                { kind: 'datatables', count: 14, items: [{ title: 'Customers', count: 8 }, { title: 'Quotes', count: 6, retention_note: '6 rows in Quotes fall under the fiscal retention duty (7 years) — anonymised, not deleted.' }] },
                { kind: 'form_answers', count: 1 },
                { kind: 'kb_documents', count: 0 },
            ],
        });
        renderDrawer({ loadTimeline, loadDiscovery, orgUsers: ORG_USERS });
        expect(screen.queryByTestId('dsr-drawer-found')).toBeNull();
        await waitFor(() => expect(within(screen.getByTestId('dsr-drawer-timeline')).getAllByRole('listitem')).toHaveLength(3));
        expect(loadTimeline).toHaveBeenCalledWith(2038);
        expect(screen.getByTestId('dsr-drawer-timeline')).toHaveTextContent('Acknowledgement e-mailed');
        expect(screen.getByTestId('dsr-drawer-timeline')).toHaveTextContent('Deadline passed · DPO notified · by Marieke de Wit');
        expect(screen.getByTestId('dsr-drawer-timeline')).not.toHaveTextContent('u_marieke');
        const found = await screen.findByTestId('dsr-drawer-found');
        expect(within(found).getByTestId('dsr-drawer-chip-memories')).toHaveTextContent('2 memories');
        expect(within(found).getByTestId('dsr-drawer-chip-rows')).toHaveTextContent('14 rows · Customers, Quotes');
        expect(within(found).getByTestId('dsr-drawer-chip-form_answers')).toHaveTextContent('1 form answers');
        const kb = within(found).getByTestId('dsr-drawer-chip-kb_documents');
        expect(kb).toHaveTextContent('0 knowledge-base documents');
        expect(kb.className).toContain('text-[var(--text-tertiary)]');
        expect(screen.getByTestId('dsr-drawer-retention')).toHaveTextContent('fiscal retention duty');
    });

    it('a 404 on both loaders → fallback timeline, no "Found" section', async () => {
        const fail = vi.fn().mockRejectedValue(new Error('404 Not Found'));
        renderDrawer({ loadTimeline: fail, loadDiscovery: fail });
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });
        expect(fail).toHaveBeenCalledTimes(2);
        expect(within(screen.getByTestId('dsr-drawer-timeline')).getAllByRole('listitem')).toHaveLength(3);
        expect(screen.queryByTestId('dsr-drawer-found')).toBeNull();
    });

    it('pure helpers: normaliseTimelineRow tolerates the column names, readDiscovery reads both spellings', () => {
        expect(normaliseTimelineRow(t, { occurred_at: iso(NOW), event: 'started', actor_name: 'T. Smit' })).toEqual({ at: NOW, text: 'started · by T. Smit', tone: null });
        expect(normaliseTimelineRow(t, { at: iso(NOW), kind: 'deadline_expired', text: 'Deadline passed' }).tone).toBe('error');
        expect(normaliseTimelineRow(t, null)).toBeNull();
        expect(readDiscovery({ memories: 2, rows: 14, tables: ['Customers'], form_answers: 1, kb_documents: 0, retained_rows: 6 }))
            .toMatchObject({ memories: 2, rows: 14, tables: ['Customers'], form_answers: 1, kb_documents: 0, retained_rows: 6 });
        expect(readDiscovery(null)).toBeNull();
        expect(discoveryChips(t, {})).toEqual([]);
        expect(discoveryChips(t, { sources: [{ kind: 'prior_requests', count: 3 }] })).toEqual([]);
    });

    it('team chat messages and project participation get their own chips, never counted as documents or rows', () => {
        const chips = discoveryChips(t, { sources: [
            { kind: 'team_chat_messages', count: 7 },
            { kind: 'project_participation', count: 5, items: [{ kind: 'project_documents', count: 2 }] },
            { kind: 'kb_documents', count: 1 },
        ] });
        const byId = Object.fromEntries(chips.map(c => [c.id, c]));
        expect(byId.team_chat.label).toBe('7 team chat messages they wrote');
        expect(byId.projects.label).toBe('5 project items');
        expect(byId.kb_documents.label).toBe('1 knowledge-base documents');
        expect(readDiscovery({ sources: [{ kind: 'project_participation', count: null }] }).projects).toBeNull();
    });

});

describe('DsrDrawer — timeline words and actors', () => {
    it('a row without text reads its kind through compliance.dsr_timeline_<kind> (or its own label_key)', () => {
        const spy = vi.fn((key, fallback) => (key === 'compliance.dsr_timeline_ack_sent' ? 'Acknowledgement e-mailed to the data subject' : t(key, fallback)));
        expect(normaliseTimelineRow(spy, { at: iso(NOW), kind: 'ack_sent', text: null, by: null }))
            .toEqual({ at: NOW, text: 'Acknowledgement e-mailed to the data subject', tone: null });
        expect(spy).toHaveBeenCalledWith('compliance.dsr_timeline_ack_sent', 'ack_sent');
        normaliseTimelineRow(spy, { at: iso(NOW), kind: 'received', label_key: 'compliance.dsr_timeline_received' });
        expect(spy).toHaveBeenCalledWith('compliance.dsr_timeline_received', 'received');
        expect(normaliseTimelineRow(spy, { at: iso(NOW), kind: 'email_failed' }).tone).toBe('error');
    });

    it('the actor is a name from the roster, or "a handler" — never the raw id; a system row names nobody', () => {
        expect(actorName(t, 'u_marieke', ORG_USERS)).toBe('Marieke de Wit');
        expect(actorName(t, 'u_unknown', ORG_USERS)).toBe('a handler');
        expect(actorName(t, 'u_unknown', null)).toBe('a handler');
        expect(actorName(t, null, ORG_USERS)).toBeNull();
        expect(actorName(t, 'u_marieke', ORG_USERS, 'T. Smit')).toBe('T. Smit');
        expect(normaliseTimelineRow(t, { at: iso(NOW), kind: 'started', by: 'u_x' }, ORG_USERS).text).toBe('started · by a handler');
        expect(fallbackTimeline(t, { ...OPEN, started_by_name: undefined, started_by: 'u_marieke' }, NOW, ORG_USERS).map(r => r.text))
            .toContain('Started by Marieke de Wit');
        expect(fallbackTimeline(t, { ...OPEN, started_by_name: undefined, started_by: 'u_gone' }, NOW, ORG_USERS).map(r => r.text))
            .toContain('Started by a handler');
    });

    it('fallbackTimeline for a completed request ends with the fulfilment row and has no overdue row', () => {
        const rows = fallbackTimeline(t, DONE, NOW);
        expect(rows.map(r => r.text)).toEqual(['Received via Phone · clock started', 'Fulfilled · data subject e-mailed']);
    });
});

describe('DsrDrawer — modes', () => {
    it('overlay mode renders the scrim; modal mode renders a right-placed dialog', () => {
        const { rerender } = renderDrawer({ mode: 'overlay' });
        expect(screen.getByTestId('dsr-drawer')).toHaveAttribute('data-mode', 'overlay');
        expect(screen.getByTestId('dsr-drawer-scrim')).toBeTruthy();
        rerender(<DsrDrawer open request={OPEN} mode="modal" onClose={vi.fn()} />);
        expect(screen.getByRole('dialog')).toBeTruthy();
        expect(screen.getByTestId('dsr-drawer')).toHaveAttribute('data-mode', 'modal');
        expect(screen.getByTestId('dsr-drawer-email')).toHaveTextContent('j.•••@gmail.com');
    });
});
