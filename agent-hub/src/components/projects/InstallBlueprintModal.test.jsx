import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: (...args) => globalThis.__authFetch(...args),
}));

import InstallBlueprintModal from './InstallBlueprintModal';

/**
 * The install wizard.
 *
 * What is worth pinning here is not the three steps — it is the two promises
 * they make:
 *
 *   1. A FILE CANNOT GRANT ITSELF ANYTHING. The tools and the public-AI flags a
 *      Blueprint asks for are shown UNTICKED, a ticked one is handed over
 *      through the PAGE'S OWN grants route rather than through the install
 *      body, and nothing about grants ever appears in `resolutions`.
 *   2. WHAT SOMEBODY CHOSE IS WHAT IS SENT. The Connect step's answers travel
 *      as `resolutions`, and a question that was not asked contributes nothing.
 *
 * Plus the rule that runs through the whole screen: a list that could not be
 * read never renders as an empty one.
 */

const routine = (ref, steps) => ({
    ref, kind: 'automation', title: `Routine ${ref}`,
    definition: { schemaVersion: 2, trigger: { id: 't', type: 'trigger' }, steps },
});

const manifest = (entities, over = {}) => ({
    format: 'beeflow.blueprint',
    solution: {
        key: 'sol_1', version: 2, name: 'Onboarding', description: '',
        entities: { automations: [], apps: [], webpages: [], datatables: [], agents: [], knowledgeBases: [], ...entities },
        ...over,
    },
});

const CATALOG = {
    apps: [
        { id: 'gmail', label: 'Gmail', available: true, actions: [{ name: 'gmail_send', label: 'Send mail' }] },
        { id: 'slack', label: 'Slack', available: false, actions: [{ name: 'slack_post_message' }] },
    ],
    datatables: [{ id: 'tbl_theirs', name: 'Our contacts', key: 'contacts' }],
};

/** Routes every request the wizard can make; overrides win. */
function mockFetch(over = {}) {
    const calls = [];
    globalThis.__authFetch = vi.fn(async (url, init) => {
        calls.push({ url, init });
        for (const [pattern, handler] of Object.entries(over)) {
            if (url.includes(pattern)) return handler(url, init);
        }
        if (url.includes('/api/automation/catalog')) return ok(CATALOG);
        if (url.includes('/api/integrations/connections')) return ok({ connections: [{ id: 'conn_1', label: 'Our API key' }] });
        if (url.includes('/auth/users')) return ok([{ id: 'u1', username: 'ada' }]);
        if (url.includes('/auth/groups')) return ok([{ id: 'g1', name: 'Finance' }]);
        if (url.includes('/package/install')) {
            return ok({ projectId: 'p_new', report: { installed: { webpages: [{ ref: 'web_1', id: 'wp_new' }] }, skipped: [], warnings: [], grantRequires: [] } });
        }
        return ok({});
    });
    globalThis.__calls = calls;
    return calls;
}

const ok = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const fail = (status = 500, body = {}) => ({ ok: false, status, json: async () => body });

const open = (source) => render(<InstallBlueprintModal open source={source} onClose={() => {}} onInstalled={() => {}} />);

const installBody = () => JSON.parse(
    globalThis.__calls.find(c => c.url.includes('/package/install')).init.body,
);

async function toStep(n) {
    for (let i = 1; i < n; i++) fireEvent.click(screen.getByTestId('install-next'));
    await waitFor(() => expect(screen.getByTestId(n === 3 ? 'install-confirm' : 'install-next')).toBeTruthy());
}

beforeEach(() => mockFetch());
afterEach(() => { delete globalThis.__authFetch; delete globalThis.__calls; });

describe('step 1 — what is in it', () => {
    it('counts what will install and forwards what the Blueprint does not carry', async () => {
        open({ manifest: manifest(
            { automations: [routine('aut_1', [])], webpages: [{ ref: 'web_1', name: 'Status' }] },
            { report: { warnings: ['A page\'s stored data stays behind.'] } },
        ) });
        const chips = screen.getByTestId('install-contents').textContent;
        expect(chips).toContain('1 routine');
        expect(chips).not.toContain('1 routines');
        expect(screen.getByTestId('install-not-carried').textContent).toMatch(/stored data stays behind/);
    });

    it('counts in the singular when there is one of something', async () => {
        // "1 routines" on the first screen somebody sees of a Solution is the
        // kind of wrong that makes a careful product look careless, and the
        // choice belongs to the KEY, not to a ternary around a letter.
        open({ manifest: manifest({
            automations: [routine('aut_1', [])],
            apps: [{ ref: 'app_1', name: 'A' }, { ref: 'app_2', name: 'B' }],
        }) });
        const chips = screen.getByTestId('install-contents').textContent;
        expect(chips).toContain('1 routine');
        expect(chips).not.toContain('1 routines');
        expect(chips).toContain('2 apps');
    });

    it('says the footer sentence on every step', async () => {
        open({ manifest: manifest({}) });
        expect(screen.getByTestId('install-footer-note').textContent).toMatch(/arrives as a draft/i);
    });

    it('a file that is not a Blueprint blocks the wizard instead of installing something unseen', async () => {
        open({ manifest: { holiday: 'photos' } });
        expect(screen.getByTestId('install-unreadable')).toBeTruthy();
        expect(screen.getByTestId('install-next').disabled).toBe(true);
    });

    it('a gallery Blueprint is fetched before anything is described', async () => {
        mockFetch({ '/package/blueprints/bp_1': () => ok({ blueprint: { manifest: manifest({ apps: [{ ref: 'app_1', name: 'A' }] }) } }) });
        open({ blueprintId: 'bp_1' });
        await waitFor(() => expect(screen.getByTestId('install-contents').textContent).toContain('1 app'));
    });

    it('a gallery Blueprint that will not load is refused, never installed blind', async () => {
        mockFetch({ '/package/blueprints/bp_1': () => fail(404, { error: 'Not found' }) });
        open({ blueprintId: 'bp_1' });
        await waitFor(() => expect(screen.getByTestId('install-unreadable')).toBeTruthy());
    });

    it('a gallery row that answers WITHOUT a manifest is refused too, not shown as empty', async () => {
        // The third unreadable case, and the one that looks like success: a 200
        // with nothing in it. An empty step 1 here would be the wizard's own
        // version of "silence reads as good news".
        mockFetch({ '/package/blueprints/bp_1': () => ok({ blueprint: {} }) });
        open({ blueprintId: 'bp_1' });
        await waitFor(() => expect(screen.getByTestId('install-unreadable')).toBeTruthy());
        expect(screen.queryByTestId('install-contents')).toBeNull();
    });
});

describe('step 2 — what the installer supplies', () => {
    const withHoles = manifest({
        automations: [routine('aut_1', [
            { id: 's1', type: 'datatable', datatableId: '', datatableKey: 'contacts' },
            { id: 's2', type: 'http_request', auth: null },
            { id: 's3', type: 'approval', approval: {} },
        ])],
    });

    it('asks one question per hole the scrub left', async () => {
        open({ manifest: withHoles });
        await toStep(2);
        expect(screen.getAllByTestId('install-require-table')).toHaveLength(1);
        expect(screen.getAllByTestId('install-require-connection')).toHaveLength(1);
        expect(screen.getAllByTestId('install-require-approver')).toHaveLength(1);
    });

    it('sends the answers as resolutions, and nothing for what was left alone', async () => {
        open({ manifest: withHoles });
        await toStep(2);
        await waitFor(() => expect(screen.getByTestId('install-require-table').querySelectorAll('option')).toHaveLength(3));

        fireEvent.change(screen.getByTestId('install-require-table').querySelector('select'), { target: { value: 'tbl_theirs' } });
        fireEvent.change(screen.getByTestId('install-require-connection').querySelector('select'), { target: { value: 'conn_1' } });
        fireEvent.click(screen.getByTestId('install-next'));
        fireEvent.click(screen.getByTestId('install-confirm'));

        await waitFor(() => expect(screen.getByTestId('install-done')).toBeTruthy());
        expect(installBody().resolutions).toEqual({
            tables: [{ key: 'contacts', datatableId: 'tbl_theirs' }],
            connections: [{ ref: 'aut_1', stepId: 's2', layerKey: null, connectionId: 'conn_1' }],
            // Left on "the Solution's owner decides", so nothing is sent.
            approvers: [],
        });
    });

    it('offers an empty table when the recipient has none to point at', async () => {
        open({ manifest: manifest({ automations: [routine('aut_1', [
            { id: 's1', type: 'datatable', datatableId: '', datatableKey: 'invoices' },
        ])] }) });
        await toStep(2);
        fireEvent.change(screen.getByTestId('install-require-table').querySelector('select'),
            { target: { value: '__create_empty__' } });
        fireEvent.click(screen.getByTestId('install-next'));
        fireEvent.click(screen.getByTestId('install-confirm'));
        await waitFor(() => expect(screen.getByTestId('install-done')).toBeTruthy());
        expect(installBody().resolutions.tables).toEqual([{ key: 'invoices', create: true }]);
    });

    it('A CATALOGUE THAT COULD NOT BE READ NEVER READS AS "YOU HAVE NO TABLES"', async () => {
        mockFetch({ '/api/automation/catalog': () => fail(500) });
        open({ manifest: withHoles });
        await toStep(2);
        await waitFor(() => expect(screen.getByTestId('install-tables-unavailable')).toBeTruthy());
    });
});

describe('what the file ASKS for — the part an install refuses', () => {
    const asking = manifest({
        webpages: [{
            ref: 'web_1', name: 'Status',
            bridgeGrants: {
                ai: { publicEnabled: true, publicSpendCapUsd: 50 },
                integrations: [{ tool: 'gmail_send', fixedArgs: { to: 'LEAK-CANARY@example.test' } }],
            },
        }],
    });

    it('A TOOL THE FILE ASKED FOR ARRIVES UNTICKED', async () => {
        // The whole point. A ticked box would restore, one screen higher, the
        // behaviour install.js was hardened to remove.
        open({ manifest: asking });
        await toStep(2);
        await waitFor(() => expect(screen.getByTestId('install-grant-integration')).toBeTruthy());
        expect(screen.getByTestId('install-grant-integration').querySelector('input[type=checkbox]').checked).toBe(false);
    });

    it('and its pinned arguments are never put on the screen', async () => {
        open({ manifest: asking });
        await toStep(2);
        await waitFor(() => expect(screen.getByTestId('install-grant-integration')).toBeTruthy());
        expect(document.body.textContent).not.toContain('LEAK-CANARY');
    });

    it('public AI is shown as a request and offered no control at all', async () => {
        open({ manifest: asking });
        await toStep(2);
        const row = screen.getByTestId('install-grant-public-ai');
        expect(row.textContent).toMatch(/anonymous visitors/i);
        expect(row.textContent).toMatch(/50/);
        expect(row.querySelector('input')).toBeNull();
    });

    it('NOTHING ABOUT GRANTS TRAVELS IN THE INSTALL BODY, TICKED OR NOT', async () => {
        open({ manifest: asking });
        await toStep(2);
        await waitFor(() => expect(screen.getByTestId('install-grant-integration')).toBeTruthy());
        fireEvent.click(screen.getByTestId('install-grant-integration').querySelector('input[type=checkbox]'));
        fireEvent.click(screen.getByTestId('install-next'));
        fireEvent.click(screen.getByTestId('install-confirm'));
        await waitFor(() => expect(screen.getByTestId('install-done')).toBeTruthy());

        // The manifest itself travels, and must: the server needs the file,
        // and sanitizeManifest is what strips the never-installable half of it.
        // What must NOT travel is a second input claiming to grant any of it.
        const body = installBody();
        expect(Object.keys(body).sort()).toEqual(['manifest', 'name', 'resolutions']);
        expect(Object.keys(body.resolutions).sort()).toEqual(['approvers', 'connections', 'tables']);
        expect(JSON.stringify(body.resolutions)).not.toContain('gmail_send');
        expect(JSON.stringify(body.resolutions)).not.toContain('publicEnabled');
    });

    it('a ticked tool is handed over through the PAGE\'S OWN grants route, after the install', async () => {
        open({ manifest: asking });
        await toStep(2);
        await waitFor(() => expect(screen.getByTestId('install-grant-integration')).toBeTruthy());
        fireEvent.click(screen.getByTestId('install-grant-integration').querySelector('input[type=checkbox]'));
        fireEvent.click(screen.getByTestId('install-next'));
        fireEvent.click(screen.getByTestId('install-confirm'));
        await waitFor(() => expect(screen.getByTestId('install-done')).toBeTruthy());

        const grant = globalThis.__calls.find(c => c.url.includes('/grants/integrations'));
        expect(grant.url).toContain('/api/webpages/wp_new/grants/integrations');
        expect(JSON.parse(grant.init.body)).toEqual({ tool: 'gmail_send' });
        // The order matters: the page has to exist before it can be granted to.
        const idx = (needle) => globalThis.__calls.findIndex(c => c.url.includes(needle));
        expect(idx('/package/install')).toBeLessThan(idx('/grants/integrations'));
    });

    it('a tool for an app the installer has not connected cannot be ticked at all', async () => {
        open({ manifest: manifest({
            webpages: [{ ref: 'web_1', name: 'Status', bridgeGrants: { integrations: [{ tool: 'slack_post_message' }] } }],
        }) });
        await toStep(2);
        await waitFor(() => expect(screen.getByTestId('install-grant-integration')).toBeTruthy());
        const box = screen.getByTestId('install-grant-integration').querySelector('input[type=checkbox]');
        expect(box.disabled).toBe(true);
        expect(screen.getByTestId('install-grant-integration').textContent).toMatch(/Not connected/i);
    });

    it('A CATALOGUE THAT COULD NOT BE READ IS NOT "YOU HAVE NOT CONNECTED THIS"', async () => {
        // Saying "not connected" would send somebody to Settings for an app
        // they already have. Unknown refuses the tick just the same — a grant
        // is only offered where the connection is confirmed.
        mockFetch({ '/api/automation/catalog': () => fail(500) });
        open({ manifest: asking });
        await toStep(2);
        await waitFor(() => expect(screen.getByTestId('install-grant-integration')).toBeTruthy());
        const row = screen.getByTestId('install-grant-integration');
        expect(row.textContent).toMatch(/could not be checked/i);
        expect(row.textContent).not.toMatch(/Not connected to your account/i);
        expect(row.querySelector('input[type=checkbox]').disabled).toBe(true);
    });

    it('a grant that the server refused is reported, and the install still counts as done', async () => {
        mockFetch({ '/grants/integrations': () => fail(409, { code: 'connection_required', error: 'Connect Gmail first' }) });
        open({ manifest: asking });
        await toStep(2);
        await waitFor(() => expect(screen.getByTestId('install-grant-integration')).toBeTruthy());
        fireEvent.click(screen.getByTestId('install-grant-integration').querySelector('input[type=checkbox]'));
        fireEvent.click(screen.getByTestId('install-next'));
        fireEvent.click(screen.getByTestId('install-confirm'));

        await waitFor(() => expect(screen.getByTestId('install-result-failures')).toBeTruthy());
        expect(screen.getByTestId('install-result-failures').textContent).toMatch(/Connect Gmail first/);
        expect(screen.getByTestId('install-done')).toBeTruthy();
    });
});

describe('step 3 and after', () => {
    it('shares with the people the installer added, through the project\'s own route', async () => {
        open({ manifest: manifest({}) });
        await toStep(3);
        await waitFor(() => expect(screen.getByTestId('install-access-add')).toBeTruthy());
        fireEvent.change(screen.getByLabelText('Who to add'), { target: { value: 'u1' } });
        fireEvent.change(screen.getByLabelText('What they may do'), { target: { value: 'editor' } });
        fireEvent.click(screen.getByTestId('install-access-add'));
        expect(screen.getByTestId('install-access-list').textContent).toMatch(/ada/);

        fireEvent.click(screen.getByTestId('install-confirm'));
        await waitFor(() => expect(screen.getByTestId('install-done')).toBeTruthy());
        const share = globalThis.__calls.find(c => c.url.includes('/share'));
        expect(JSON.parse(share.init.body)).toEqual({ sharedWithType: 'user', sharedWithId: 'u1', permission: 'editor' });
    });

    it('THE SERVER\'S OWN LIST OF WHAT IT REFUSED IS SHOWN, EVEN IF THIS SCREEN MISSED IT', async () => {
        // The client reads the file with its own eyes and the server decides.
        // Rendering `report.grantRequires` regardless is what stops a drift
        // between the two from becoming a silence.
        mockFetch({
            '/package/install': () => ok({
                projectId: 'p_new',
                report: {
                    installed: { webpages: [] }, skipped: [], warnings: [],
                    grantRequires: [{ ref: 'web_9', name: 'Something', kind: 'integration', tool: 'nextcloud_upload_file' }],
                },
            }),
        });
        open({ manifest: manifest({}) });
        await toStep(3);
        fireEvent.click(screen.getByTestId('install-confirm'));
        await waitFor(() => expect(screen.getByTestId('install-result-grants')).toBeTruthy());
        expect(screen.getByTestId('install-result-grants').textContent).toMatch(/nextcloud_upload_file/);
    });

    it('a refused install says so and creates no result screen', async () => {
        mockFetch({ '/package/install': () => fail(403, { error: 'feature_locked' }) });
        open({ manifest: manifest({}) });
        await toStep(3);
        fireEvent.click(screen.getByTestId('install-confirm'));
        await waitFor(() => expect(screen.getByTestId('install-error')).toBeTruthy());
        expect(screen.queryByTestId('install-done')).toBeNull();
    });
});

describe('waar dit bestand zégt vandaan te komen', () => {
    // Een manifest is invoer van buiten. `source.orgName` is tekst die in het
    // bestand staat en verder niets; het scherm mag hem tonen, maar alleen als
    // wat hij is. De server beslist met canRead over de echte galerijrij, en
    // die vraag raakt dit blok niet aan.

    const fromFile = (source, entities = {}) => ({ ...manifest(entities), source });

    it('toont de naam uit het bestand als BEWERING, nooit als afzender', async () => {
        open({ manifest: fromFile({ blueprintId: 'bp_abc', orgId: 'org1', orgName: 'Acme', version: 3 }) });
        const claim = screen.getByTestId('install-source-claim').textContent;
        expect(claim).toContain('Acme');
        expect(claim).toContain('version 3');
        // De zin eromheen is het hele punt: zonder haar leest andermans naam
        // als een vastgesteld feit.
        expect(claim).toMatch(/says/i);
        expect(claim).toMatch(/anyone who can edit the file can change it/i);
    });

    it('zegt niets als het bestand niets beweert', async () => {
        // Geen "afkomstig van —": een lege regel voegt niets toe en suggereert
        // dat er iets ontbreekt.
        open({ manifest: manifest({}) });
        expect(screen.queryByTestId('install-source-claim')).toBeNull();
    });

    it('een bewering zonder naam is geen bewering', async () => {
        // Een id zegt de lezer niets; alleen een naam is iets om over na te
        // denken, en zonder naam is er dus niets te tonen.
        open({ manifest: fromFile({ blueprintId: 'bp_abc', orgId: 'org1' }) });
        expect(screen.queryByTestId('install-source-claim')).toBeNull();
    });

    it('een bewering reist niet mee naar de installatieroute', async () => {
        // De server leest de herkomst uit het MANIFEST dat hij zelf al heeft.
        // Zou de wizard hem los meesturen, dan was er een tweede weg naar die
        // kolommen — precies wat er bij de grants is afgeschaft.
        open({ manifest: fromFile({ blueprintId: 'bp_abc', orgId: 'org1', orgName: 'Acme' }) });
        await toStep(3);
        fireEvent.click(screen.getByTestId('install-confirm'));
        await waitFor(() => expect(globalThis.__calls.some(c => c.url.includes('/package/install'))).toBe(true));
        const body = installBody();
        expect(body.source).toBeUndefined();
        expect(body.blueprintId).toBeUndefined();
        expect(body.orgId).toBeUndefined();
    });
});
