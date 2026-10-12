import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { queryWrapper } from '../../../../../../test/queryWrapper';
import ChatMonitoringCard from './ChatMonitoringCard';
import { addDaysUtc, defaultStartDate, utcDay } from './chatMonitoringForm';

/**
 * The chat-signals card in Compliance Settings, against a fake server: the
 * network is a spy on fetch (authFetch's only exit). Every route the card
 * uses answers from the variables below.
 */

const TODAY = utcDay(new Date());

function baseConfig() {
    return {
        settings: {
            enabled: false, surfaces: [], signals: [], effective_from: null, retention_days: 90, legal_basis: null, lia_at: null,
            works_council: null, works_council_reason: null, works_council_at: null,
            works_council_scope: { surfaces: [], signals: [], max_retention_days: null },
            dpia_ref: null, dpia_at: null, dpia_risk_level: null, dpo_advice_at: null, prior_consultation_at: null,
            notice_url: null, notice_published_at: null, enabled_at: null, enabled_by_name: null,
        },
        effective: { state: 'off', version: null, from: null, surfaces: [], paused: [], signals: [], noticeUrl: null, visitorNoticeUrl: null, retentionDays: 90 },
        catalogue: {
            surfaces: [
                { id: 'direct', population: 'employees', available: true },
                { id: 'agent', population: 'employees', available: true },
                { id: 'agent_public', population: 'visitors', available: true },
                { id: 'notebook', population: 'employees', available: false },
            ],
            retention: { min: 30, max: 90, default: 90 }, k: { outcomes: 5, kinds: 10 },
        },
        dpia: { kind: 'none', current: false, expires_at: null, risk_level: null, approved_at: null },
        dpo_recorded: false,
        contributors: { direct: '10-24', agent: '<5' },
        install_has_organisations: true,
        privacy_notice_url_set: true,
        template: { dpo_contact: 'dpo@example.org', dsr_url: 'https://bee.example.org/privacy/requests', shield_log_retention_days: 400 },
        can_widen: true,
    };
}

let config: ReturnType<typeof baseConfig>;
let putStatus: number;
let putBody: Record<string, unknown> | null;
let summary: unknown;
let configStatus: number;
let fetchSpy: MockInstance<typeof fetch>;

const reply = (body: unknown, status = 200) => ({ ok: status < 300, status, statusText: String(status), json: async () => body }) as unknown as Response;

beforeEach(() => {
    config = baseConfig();
    putStatus = 200;
    putBody = null;
    summary = { surfaces: {} };
    configStatus = 200;
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.includes('/chat-monitoring/summary')) return reply(summary);
        if (url.includes('/chat-monitoring/counts')) return reply({ deleted: 3 });
        if (url.endsWith('/chat-monitoring') && init?.method === 'PUT') {
            putBody = JSON.parse(String(init.body));
            if (putStatus === 422) return reply({ error: 'x', code: 'chat_monitoring_preconditions', details: { missing: ['dpia'] } }, 422);
            if (putStatus === 403) return reply({ error: 'x', code: 'chat_monitoring_widen_forbidden' }, 403);
            return reply({ ...config, settings: { ...config.settings, enabled: true } });
        }
        if (url.endsWith('/chat-monitoring')) return reply(config, configStatus);
        if (url.endsWith('/ropa')) return reply({ organization_id: 'org1', controller: { name: 'Acme' }, activities: [] });
        return reply({}, 404);
    });
});
afterEach(() => { fetchSpy.mockRestore(); });

const renderCard = () => render(<ChatMonitoringCard orgName="Acme" />, { wrapper: queryWrapper() });
const submit = () => screen.getByTestId('cm-submit') as HTMLButtonElement;
const box = (testId: string) => screen.getByTestId(testId).querySelector('input') as HTMLInputElement;

async function openSetup(user: UserEvent) {
    renderCard();
    await user.click(await screen.findByTestId('cm-set-up'));
    return screen.getByTestId('cm-setup');
}

async function retype(user: UserEvent, el: HTMLElement, text: string) {
    await user.clear(el);
    await user.type(el, text);
}

/** Everything direct chat needs, with an external DPIA and "not applicable" works council. */
async function fillDirectChat(user: UserEvent) {
    await user.click(box('cm-surface-direct'));
    await user.click(screen.getByTestId('cm-basis-art6_1_e'));
    await user.selectOptions(screen.getByTestId('cm-wc'), 'not_applicable');
    await user.selectOptions(screen.getByTestId('cm-wc-reason'), 'no_works_council');
    await user.click(box('cm-dpia-external'));
    await user.type(screen.getByTestId('cm-dpia-ref'), 'DPIA-7');
    await retype(user, screen.getByTestId('cm-dpia-at'), addDaysUtc(TODAY, -30));
    await user.selectOptions(screen.getByTestId('cm-dpia-risk'), 'medium');
    await user.type(screen.getByTestId('cm-notice-url'), 'https://intranet.example.org/chat-signals');
    await retype(user, screen.getByTestId('cm-notice-published'), addDaysUtc(TODAY, -1));
    await user.click(box('cm-ack-notice'));
    await user.click(box('cm-ack-ropa'));
}

describe('ChatMonitoringCard: off', () => {
    it('lists what is never kept, the people-to-people line and the legal caveat', async () => {
        renderCard();
        expect(await screen.findByTestId('cm-off')).toBeTruthy();
        expect(screen.getByTestId('cm-never-kept').textContent).toContain('Never kept');
        expect(screen.getByTestId('cm-never-kept').textContent).toContain('Health data, in any form');
        expect(screen.getByTestId('cm-h2h').textContent).toBe('Messages between people are never counted.');
        expect(screen.getByTestId('cm-caveat').textContent).toContain('This is not legal advice.');
        expect(screen.getByTestId('cm-state-pill').textContent).toBe('Off');
        expect(screen.getByTestId('chat-monitoring-card').textContent).not.toMatch(/anonym|employee monitoring/i);
    });

    it('shows no card when the server has no such route', async () => {
        configStatus = 404;
        renderCard();
        await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
        await waitFor(() => expect(screen.queryByTestId('chat-monitoring-card')).toBeNull());
    });
});

describe('ChatMonitoringCard: set-up form', () => {
    it('"Switch on" is disabled until the preconditions hold', async () => {
        const user = userEvent.setup();
        await openSetup(user);
        expect(submit().textContent).toBe('Switch on');
        expect(submit().disabled).toBe(true);
        expect(screen.getByTestId('cm-missing').textContent).toContain('Choose at least one chat type');
        await fillDirectChat(user);
        await waitFor(() => expect(submit().disabled).toBe(false));
        expect(screen.queryByTestId('cm-missing')).toBeNull();
        await user.click(submit());
        await waitFor(() => expect(putBody).not.toBeNull());
        expect(putBody).toMatchObject({ enabled: true, surfaces: ['direct'], legal_basis: 'art6_1_e', effective_from: null, acknowledgements: { notice_published: true, ropa_reviewed: true } });
    });

    it('shows the contributor band under an employee chat type, and the notebook as coming later', async () => {
        const user = userEvent.setup();
        await openSetup(user);
        expect(screen.getByTestId('cm-contributors-direct').textContent).toBe('10 to 24 active people in the last 4 weeks');
        expect(box('cm-surface-notebook').disabled).toBe(true);
        expect(screen.getByTestId('cm-surface-notebook').textContent).toContain('Coming later');
    });

    it('the start date defaults to seven days out', async () => {
        const user = userEvent.setup();
        await openSetup(user);
        await user.click(box('cm-surface-direct'));
        expect((screen.getByTestId('cm-start-date') as HTMLInputElement).value).toBe(defaultStartDate(new Date()));
    });

    it('"pending" blocks employee chat types only', async () => {
        const user = userEvent.setup();
        await openSetup(user);
        await user.click(box('cm-surface-agent_public'));
        await user.click(screen.getByTestId('cm-basis-art6_1_e'));
        await user.click(box('cm-ack-notice'));
        await user.click(box('cm-ack-ropa'));
        await waitFor(() => expect(submit().disabled).toBe(false));
        await user.click(box('cm-surface-direct'));
        await user.selectOptions(screen.getByTestId('cm-wc'), 'pending');
        expect(screen.getByTestId('cm-wc-pending').textContent).toContain('WOR art. 27(1)(l)');
        expect(within(screen.getByTestId('cm-missing')).getByText('Works-council consent, or why it does not apply')).toBeTruthy();
        expect(submit().disabled).toBe(true);
    });
});

describe('ChatMonitoringCard: refusals', () => {
    it('shows a 422 by the labels of its missing codes', async () => {
        putStatus = 422;
        const user = userEvent.setup();
        await openSetup(user);
        await fillDirectChat(user);
        await waitFor(() => expect(submit().disabled).toBe(false));
        await user.click(submit());
        const list = await screen.findByTestId('cm-error-missing');
        expect(list.textContent).toContain('This cannot be saved yet. Missing:');
        expect(list.textContent).toContain('A current DPIA');
        expect(list.textContent).not.toContain('dpia');
    });

    it('a widen this admin may not make is disabled with the reason', async () => {
        config.can_widen = false;
        const user = userEvent.setup();
        await openSetup(user);
        await fillDirectChat(user);
        expect(screen.getByTestId('cm-error-forbidden').textContent).toContain('Only an organisation admin can switch this on or count more.');
        expect(submit().disabled).toBe(true);
    });

    it('a 403 from the server shows the same reason', async () => {
        putStatus = 403;
        const user = userEvent.setup();
        await openSetup(user);
        await fillDirectChat(user);
        await waitFor(() => expect(submit().disabled).toBe(false));
        await user.click(submit());
        expect((await screen.findByTestId('cm-error-forbidden')).textContent).toContain('You can switch it off or count less.');
    });
});

function onConfig() {
    const c = baseConfig();
    return {
        ...c,
        settings: { ...c.settings, enabled: true, surfaces: ['direct', 'agent'], signals: ['outcomes', 'kinds'], legal_basis: 'art6_1_e', effective_from: '2026-09-07T09:00:00.000Z', enabled_by_name: 'Ada Admin' },
        effective: { ...c.effective, state: 'on', from: '2026-09-07', surfaces: ['direct'], paused: [{ surface: 'agent', missing: ['dpia'] }], signals: ['outcomes', 'kinds'] },
    };
}

describe('ChatMonitoringCard: on', () => {
    it('says since when and by whom, lists the chips and the paused chat type with its reason', async () => {
        config = onConfig() as unknown as ReturnType<typeof baseConfig>;
        renderCard();
        const line = await screen.findByTestId('cm-status-line');
        expect(line.textContent).toContain('switched on by Ada Admin');
        expect(screen.getByTestId('cm-paused-agent').textContent).toContain('Paused: Agent chat');
        expect(screen.getByTestId('cm-paused-agent').textContent).toContain('A current DPIA');
    });

    it('summary cells show <5 and "hidden", and a suppressed chat type one sentence', async () => {
        config = onConfig() as unknown as ReturnType<typeof baseConfig>;
        summary = {
            surfaces: {
                direct: {
                    status: 'shown', turns: 37,
                    pct: { scanned: 89, protected_of_found: '<5', blocked: 0, sent_unprotected: 'hidden', failed_open: 0, failed_closed: 0, unscanned_external: 3 },
                    kinds: { status: 'shown', k: 10, rows: { email: { protected: 12, exposed: '<5' } } },
                },
                agent: { status: 'suppressed', k: 5 },
            },
        };
        const user = userEvent.setup();
        renderCard();
        expect(fetchSpy.mock.calls.some(([u]) => String(u).includes('/summary'))).toBe(false);
        await user.click(await screen.findByTestId('cm-summary-open'));
        const row = await screen.findByTestId('cm-summary-row-direct');
        expect(row.querySelector('[data-cell="lt5"]')?.textContent).toBe('<5');
        expect(row.querySelector('[data-cell="hidden"]')?.textContent).toBe('hidden');
        expect(row.textContent).toContain('89%');
        expect(screen.getByTestId('cm-summary-status-agent').textContent).toBe('Hidden: fewer than 5 people used this in the period.');
        expect(screen.getByTestId('cm-summary-kinds-direct').textContent).toContain('E-mail addresses: 12 protected, <5 sent anyway');
        expect(screen.getByTestId('cm-summary').textContent).toContain('Opening this table is recorded in the access log.');
    });

    it('switching off with "Also delete" asks first, then switches off and deletes', async () => {
        config = onConfig() as unknown as ReturnType<typeof baseConfig>;
        const user = userEvent.setup();
        renderCard();
        await screen.findByTestId('cm-also-delete');
        await user.click(box('cm-also-delete'));
        await user.click(screen.getByTestId('cm-switch-off'));
        await user.click(await screen.findByTestId('confirm-dialog-confirm'));
        await waitFor(() => expect(putBody).toMatchObject({ enabled: false, effective_from: null }));
        await waitFor(() => expect(fetchSpy.mock.calls.some(([u, i]) => String(u).includes('/counts') && i?.method === 'DELETE')).toBe(true));
    });
});
