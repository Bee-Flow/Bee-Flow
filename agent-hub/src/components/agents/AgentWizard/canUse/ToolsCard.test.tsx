import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { READ } from './canUseFacts';
import { automationRows, toolRows } from './toolGrants';
import { ACT_AS, CONFIRM } from './toolGrants.helpers';
import ToolsCard from './ToolsCard';
import { type TranslateParams } from '@/hooks/useTranslation';
import { type ComponentProps } from 'react';
import { stub } from '@/test/mocks';

/**
 * The Tools card. What is pinned here is not the layout but the three narrowings that the card shares with
 * the runtime: sent ⇒ locked, unknown ⇒ also locked, no lent grant ⇒ no owner option. Plus the rule that a
 * failed catalogue yields no empty card.
 */

// The real translator interpolates `{placeholder}`. The tests rely on those numbers, so this one does too.
const t = (key: string, fallback: string, vars: TranslateParams) => {
    let out = fallback ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(String(v));
    return out;
};

const APPS = [
    {
        id: 'gmail',
        label: 'Gmail',
        available: true,
        actionsKnown: true,
        provider: 'google',
        actions: [
            { name: 'gmail_search', label: 'gmail search', effect: 'reads' },
            { name: 'gmail_compose', label: 'gmail compose', effect: 'sends' },
            { name: 'gmail_create_draft', label: 'gmail create draft', effect: 'writes' },
        ],
    },
    {
        id: 'google-drive',
        label: 'Google Drive',
        available: true,
        actionsKnown: true,
        provider: 'google',
        actions: [
            { name: 'drive_search', label: 'drive search', effect: 'reads' },
            { name: 'drive_upload_file', label: 'drive upload file', effect: 'writes' },
        ],
    },
    {
        id: 'agent-search',
        label: 'Web search',
        available: true,
        actionsKnown: true,
        provider: null,
        actions: [{ name: 'web_search', label: 'web search', effect: 'reads' }],
    },
];

function rowsFor(overrides = {}) {
    return toolRows({
        toolsConfig: null,
        enabledIntegrations: ['gmail', 'google-drive', 'agent-search'],
        apps: APPS,
        catalogState: READ.OK,
        providersKnown: true,
        lentApps: new Set(),
        lendingEnabled: false,
        ...overrides,
    });
}

function renderCard(props = {}) {
    return render(
        <ToolsCard
            t={t}
            rows={stub<ComponentProps<typeof ToolsCard>['rows']>(rowsFor())}
            apps={APPS}
            catalogState={READ.OK}
            {...props}
        />,
    );
}

afterEach(cleanup);

describe('ToolsCard — de rijen', () => {
    it('toont per app hoeveel acties aanstaan, en de werkwoorden zonder het app-woord', () => {
        renderCard({ rows: rowsFor({ toolsConfig: { gmail: { actions: ['gmail_search'] } } }) });

        expect(screen.getByText('1 of 3 actions')).toBeTruthy();
        // "gmail search" wordt "Search": de app staat al in de eerste kolom.
        expect(screen.getByText('Search')).toBeTruthy();
    });

    it('zegt "niets aangezet" in plaats van een lege kolom bij een uitgevinkte app', () => {
        renderCard({ rows: rowsFor({ toolsConfig: { gmail: { actions: [] } } }) });
        expect(screen.getByText('0 of 3 actions')).toBeTruthy();
        expect(screen.getByText('Nothing switched on')).toBeTruthy();
    });

    it('opent de kiezer op DIE app', async () => {
        const user = userEvent.setup();
        const onOpenChooser = vi.fn();
        renderCard({ onOpenChooser });

        await user.click(screen.getAllByTestId('agent-tool-open')[0]);
        expect(onOpenChooser).toHaveBeenCalledWith({ section: 'apps', appId: 'gmail' });
    });

    // A2-1: `browse_web` sits behind a docker probe. "This installation does not have it" is something other
    // than "you have not connected it", and the card may only say the sentence that is true.
    it('zegt bij een app die de INSTALLATIE mist niet dat de gebruiker hem niet verbond', () => {
        const browser = {
            id: 'browser-fetch', label: 'Browse Web', available: false, actionsKnown: true,
            requiresGrant: true, availabilityKind: 'installation', provider: null,
            actions: [{ name: 'browse_web', label: 'browse web', effect: 'writes' }],
        };
        renderCard({
            apps: [...APPS, browser],
            rows: rowsFor({ apps: [...APPS, browser], enabledIntegrations: ['browser-fetch'] }),
        });
        expect(screen.getByText(/not available on this installation/i)).toBeTruthy();
        expect(screen.queryByText(/Not connected for you/i)).toBeNull();
    });
});

describe('ToolsCard — bevestigen', () => {
    it('vergrendelt op "eerst bevestigen" zodra de app kan versturen', () => {
        renderCard();
        const rows = screen.getAllByTestId('agent-tool-row');
        const gmail = within(rows[0]);

        const ask = gmail.getByRole('radio', { name: 'Confirm first' });
        expect(ask.getAttribute('aria-checked')).toBe('true');
        expect(ask.hasAttribute('disabled')).toBe(true);
        expect(gmail.getByRole('radio', { name: 'Direct' }).hasAttribute('disabled')).toBe(true);
        expect(gmail.getByText('This app can send, so a person always confirms first.')).toBeTruthy();
    });

    it('laat de keuze vrij voor een app die niets verstuurt', async () => {
        const user = userEvent.setup();
        renderCard();
        const drive = within(screen.getAllByTestId('agent-tool-row')[1]);
        expect(drive.getByRole('radio', { name: 'Direct' }).hasAttribute('disabled')).toBe(false);
        await user.click(drive.getByRole('radio', { name: 'Confirm first' }));
    });

    it('geeft de app-id en de nieuwe waarde door', async () => {
        const user = userEvent.setup();
        const onChangeConfirm = vi.fn();
        renderCard({ onChangeConfirm });
        const drive = within(screen.getAllByTestId('agent-tool-row')[1]);
        await user.click(drive.getByRole('radio', { name: 'Confirm first' }));
        expect(onChangeConfirm).toHaveBeenCalledWith('google-drive', CONFIRM.ASK);
    });

    it('vergrendelt ÓÓK wanneer de catalogus niet gelezen kon worden — onbekend telt als versturen', () => {
        renderCard({
            rows: rowsFor({ apps: null, catalogState: READ.ERROR, providersKnown: false }),
            apps: null,
            catalogState: READ.ERROR,
        });
        for (const row of screen.getAllByTestId('agent-tool-row')) {
            expect(within(row).getByRole('radio', { name: 'Confirm first' }).getAttribute('aria-checked')).toBe('true');
            expect(within(row).getByRole('radio', { name: 'Direct' }).hasAttribute('disabled')).toBe(true);
        }
        expect(screen.getAllByText('Could not read what these actions do, so a person confirms first.').length).toBe(3);
    });

    it('is helemaal uitgeschakeld bij alleen-lezen', () => {
        renderCard({ ro: true });
        const drive = within(screen.getAllByTestId('agent-tool-row')[1]);
        expect(drive.getByRole('radio', { name: 'Direct' }).hasAttribute('disabled')).toBe(true);
        expect(screen.queryByTestId('agent-tools-link')).toBeNull();
    });
});

describe('ToolsCard — in wiens naam', () => {
    it('tekent een statische capsule zonder dropdown voor een app zonder gebruikersverbinding', () => {
        renderCard();
        const web = within(screen.getAllByTestId('agent-tool-row')[2]);
        expect(web.getByTestId('agent-tool-actas-static').textContent).toBe('As: Bee Flow');
        expect(web.queryByTestId('agent-tool-actas')).toBeNull();
    });

    it('biedt de eigenaar-optie alleen aan waar er echt geleend is', async () => {
        const user = userEvent.setup();
        renderCard({
            rows: rowsFor({ lentApps: new Set(['gmail', 'google-drive']), lendingEnabled: true }),
        });
        // Drive leent wél (leest en schrijft, verstuurt niet).
        const drive = within(screen.getAllByTestId('agent-tool-row')[1]);
        await user.click(drive.getByTestId('agent-tool-actas'));
        expect(screen.getByTestId('agent-tool-actas-owner').hasAttribute('disabled')).toBe(false);
    });

    it('weigert de eigenaar-optie zonder leen-grant, en zegt waarom', async () => {
        const user = userEvent.setup();
        renderCard();
        const drive = within(screen.getAllByTestId('agent-tool-row')[1]);
        await user.click(drive.getByTestId('agent-tool-actas'));
        const owner = screen.getByTestId('agent-tool-actas-owner');
        expect(owner.hasAttribute('disabled')).toBe(true);
        expect(owner.textContent).toContain('You have not lent a connection for this app.');
    });

    it('toont bij een onbekende catalogus de standaard, niet "Bee Flow"', () => {
        renderCard({
            rows: rowsFor({ apps: null, catalogState: READ.ERROR, providersKnown: false }),
            apps: null,
            catalogState: READ.ERROR,
        });
        const capsules = screen.getAllByTestId('agent-tool-actas-unknown');
        expect(capsules).toHaveLength(3);
        for (const c of capsules) expect(c.textContent).toBe('As: the person asking');
        expect(screen.queryByText('As: Bee Flow')).toBeNull();
    });

    it('meldt een opgeslagen "owner" die niet gehonoreerd wordt', () => {
        renderCard({
            rows: rowsFor({
                toolsConfig: { 'google-drive': { actions: '*', actAs: 'owner' } },
                lendingEnabled: true,
            }),
        });
        expect(screen.getByText(/there is no lent connection for this app/)).toBeTruthy();
    });

    it('geeft de keuze door met de app-id', async () => {
        const user = userEvent.setup();
        const onChangeActAs = vi.fn();
        renderCard({
            rows: rowsFor({ lentApps: new Set(['gmail', 'google-drive']), lendingEnabled: true }),
            onChangeActAs,
        });
        const drive = within(screen.getAllByTestId('agent-tool-row')[1]);
        await user.click(drive.getByTestId('agent-tool-actas'));
        await user.click(screen.getByTestId('agent-tool-actas-owner'));
        expect(onChangeActAs).toHaveBeenCalledWith('google-drive', ACT_AS.OWNER);
    });
});

/**
 * A2-2: the capsule and the runtime over the SAME state.
 *
 * `A2_2_CURATED` appears literally in the same form in server/core/agentRuntime/toolPolicy.test.js, where it
 * is the input of `mayLendOwnerConnection`. There the answer since A2-2 is "do not lend". Here the screen must
 * say that, instead of silently changing behaviour.
 */
const A2_2_CURATED = Object.freeze({
    // The owner has curated only Gmail. He never said anything about Drive, while his Google connection has in
    // fact been lent out.
    gmail: { actions: ['gmail_search'], actAs: 'viewer' },
});

describe('ToolsCard — de geleende verbinding zonder opgeslagen keuze (A2-2)', () => {
    it('tekent "As: the person asking" én meldt dat de geleende verbinding hier niet meer gebruikt wordt', () => {
        renderCard({
            rows: rowsFor({
                toolsConfig: A2_2_CURATED,
                lentApps: new Set(['gmail', 'google-drive']), lendingEnabled: true,
            }),
        });
        const drive = within(screen.getAllByTestId('agent-tool-row')[1]);
        expect(drive.getByTestId('agent-tool-actas').textContent).toContain('As: the person asking');
        const notice = drive.getByTestId('agent-tool-lending-unset');
        expect(notice.textContent).toContain('no longer borrows it');
        // Drive does not send anything, so the owner can still choose it, and then that way out should be listed
        // there as well.
        expect(notice.textContent).toContain('Choose “As: you”');
    });

    it('laat de remedie weg waar de eigenaar hem niet kan kiezen', () => {
        // Gmail sends, so "As: you" is not there. Naming a way out that the picker refuses is the same
        // promise-without-cover as the gap itself.
        renderCard({
            rows: rowsFor({
                toolsConfig: { 'google-drive': { actions: '*', actAs: 'viewer' } },
                lentApps: new Set(['gmail', 'google-drive']), lendingEnabled: true,
            }),
        });
        const gmail = within(screen.getAllByTestId('agent-tool-row')[0]);
        const notice = gmail.getByTestId('agent-tool-lending-unset');
        expect(notice.textContent).toContain('no longer borrows it');
        expect(notice.textContent).not.toContain('Choose “As: you”');
    });

    it('meldt bij een agent die niemand cureerde dat de verbinding wél geleend wordt', () => {
        renderCard({
            rows: rowsFor({ toolsConfig: null, lentApps: new Set(['gmail', 'google-drive']), lendingEnabled: true }),
        });
        const drive = within(screen.getAllByTestId('agent-tool-row')[1]);
        expect(drive.getByTestId('agent-tool-actas').textContent).toContain('As: the person asking');
        expect(drive.getByTestId('agent-tool-lending-uncurated').textContent)
            .toContain('still runs on your lent connection');
    });

    it('noemt op de UNCURATED-rij ook alleen een remedie die bestaat', () => {
        // The sister branch had the way out BAKED INTO the sentence, without the `canActAsOwner` gate. On Gmail
        // (which sends) the card named a menu item that does not exist and that the save rolls back anyway.
        renderCard({
            rows: rowsFor({ toolsConfig: null, lentApps: new Set(['gmail', 'google-drive']), lendingEnabled: true }),
        });
        const rows = screen.getAllByTestId('agent-tool-row');
        const gmail = within(rows[0]).getByTestId('agent-tool-lending-uncurated');
        expect(gmail.textContent).toContain('still runs on your lent connection');
        expect(gmail.textContent).not.toContain('Choose “As: you”');
        // Drive verstuurt niets, dus dáár mag de uitweg wél staan.
        expect(within(rows[1]).getByTestId('agent-tool-lending-uncurated').textContent)
            .toContain('Choose “As: you”');
    });

    it('zegt niets over lenen zolang de RUNTIME-lezing onbekend is', () => {
        // The notices are about what happens NOW when someone runs the agent, and that is read from the published
        // config. If the server could not say that (`runtimeCurated: null`), then each of the two sentences is a guess.
        renderCard({
            rows: rowsFor({
                toolsConfig: A2_2_CURATED, runtimeCurated: null,
                lentApps: new Set(['gmail', 'google-drive']), lendingEnabled: true,
            }),
        });
        expect(screen.queryByTestId('agent-tool-lending-unset')).toBeNull();
        expect(screen.queryByTestId('agent-tool-lending-uncurated')).toBeNull();
    });

    it('volgt de RUNTIME en niet de draft: gepubliceerd ongecureerd leent nog steeds', () => {
        // The draft is already curated (the owner ticked something, not yet published) while the live agent still
        // runs uncurated, and therefore still lends. The card should say that, instead of "it no longer lends".
        renderCard({
            rows: rowsFor({
                toolsConfig: A2_2_CURATED, runtimeCurated: false,
                lentApps: new Set(['gmail', 'google-drive']), lendingEnabled: true,
            }),
        });
        const drive = within(screen.getAllByTestId('agent-tool-row')[1]);
        expect(drive.getByTestId('agent-tool-lending-uncurated').textContent)
            .toContain('still runs on your lent connection');
        expect(screen.queryByTestId('agent-tool-lending-unset')).toBeNull();
    });

    it('zwijgt waar er niets geleend is', () => {
        renderCard({ rows: rowsFor({ toolsConfig: A2_2_CURATED, lendingEnabled: true }) });
        expect(screen.queryByTestId('agent-tool-lending-unset')).toBeNull();
        expect(screen.queryByTestId('agent-tool-lending-uncurated')).toBeNull();
    });
});

describe('ToolsCard — wat er niet gelezen kon worden', () => {
    it('houdt de rijen staan als de catalogus wegvalt, met een waarschuwing erboven', async () => {
        const user = userEvent.setup();
        const onRetryCatalog = vi.fn();
        renderCard({
            rows: rowsFor({ apps: null, catalogState: READ.ERROR, providersKnown: false }),
            apps: null,
            catalogState: READ.ERROR,
            onRetryCatalog,
        });

        expect(screen.getAllByTestId('agent-tool-row')).toHaveLength(3);
        expect(screen.getByTestId('agent-tools-unreadable')).toBeTruthy();
        expect(screen.queryByTestId('agent-tools-empty')).toBeNull();
        // En de telling zwijgt in plaats van "0 van 0" te beweren.
        expect(screen.getAllByText('actions unknown')).toHaveLength(3);

        await user.click(within(screen.getByTestId('agent-tools-unreadable')).getByRole('button'));
        expect(onRetryCatalog).toHaveBeenCalled();
    });

    it('zegt het apart wanneer de beschikbaarheid niet berekend kon worden', () => {
        renderCard({ catalogDegraded: true });
        expect(screen.getByTestId('agent-tools-degraded')).toBeTruthy();
        // No single row may then claim "not connected".
        expect(screen.queryByText(/Not connected for you/)).toBeNull();
    });

    it('waarschuwt over onleesbare leen-grants alleen als er een app is die verbindingen gebruikt', () => {
        renderCard({ lentState: READ.ERROR });
        expect(screen.getByTestId('agent-tools-lending-unreadable')).toBeTruthy();

        cleanup();
        const platformOnly = rowsFor({ enabledIntegrations: ['agent-search'] });
        renderCard({ rows: platformOnly, lentState: READ.ERROR });
        expect(screen.queryByTestId('agent-tools-lending-unreadable')).toBeNull();
    });

    it('zegt "geen apps" alleen als de config er echt geen heeft — dat is geen lezing', () => {
        renderCard({
            rows: [],
            apps: null,
            catalogState: READ.ERROR,
        });
        expect(screen.getByTestId('agent-tools-empty')).toBeTruthy();
    });
});

describe('ToolsCard — automations als tool', () => {
    const AUTOS = [{
        id: 'a1',
        title: 'Send the invoice',
        definition: {
            trigger: {
                kind: 'agent_call',
                parametersSchema: { type: 'object', required: ['invoiceId'], properties: { invoiceId: {}, note: {} } },
            },
        },
    }];

    it('tekent de band met parampillen uit parametersSchema', () => {
        renderCard({
            automationRows: automationRows({
                toolsConfig: { automations: { a1: { confirm: 'ask' } } },
                automations: AUTOS,
            }),
        });

        expect(screen.getByTestId('agent-automations-band').textContent).toBe('Automations as a tool');
        expect(screen.getByText('Send the invoice')).toBeTruthy();
        const pills = screen.getAllByTestId('agent-automation-param').map(p => p.textContent);
        expect(pills[0]).toContain('invoiceId');
        expect(pills[1]).toContain('note');
    });

    it('houdt een grant zonder automatisering staan en zegt dat de naam ontbreekt', () => {
        renderCard({
            automationRows: automationRows({
                toolsConfig: { automations: { a1: {} } },
                automations: null,
                state: READ.ERROR,
            }),
            automationsState: READ.ERROR,
        });
        expect(screen.getByTestId('agent-automation-row')).toBeTruthy();
        expect(screen.getByText(/this automation could not be read/)).toBeTruthy();
        expect(screen.getByTestId('agent-automations-unreadable')).toBeTruthy();
    });

    it('meldt een automatisering die de agent niet meer kan aanroepen', () => {
        renderCard({
            automationRows: automationRows({
                toolsConfig: { automations: { a2: {} } },
                automations: [{ id: 'a2', title: 'Nightly', definition: { trigger: { kind: 'schedule' } } }],
            }),
        });
        expect(screen.getByText(/no agent trigger/)).toBeTruthy();
    });

    it('meldt een gegunde automatisering die niet aan deze agent is gekoppeld, en zwijgt als dat onbekend is', () => {
        const toolsConfig = { automations: { a1: {} } };
        const { unmount } = renderCard({ automationRows: automationRows({ toolsConfig, automations: AUTOS, linkedIds: [] }) });
        expect(screen.getByText(/not linked to this agent/)).toBeTruthy();
        unmount();
        renderCard({ automationRows: automationRows({ toolsConfig, automations: AUTOS, linkedIds: ['a1'] }) });
        expect(screen.queryByText(/not linked to this agent/)).toBeNull();
    });

    it('zegt niets over koppelingen wanneer die niet te lezen waren', () => {
        renderCard({ automationRows: automationRows({ toolsConfig: { automations: { a1: {} } }, automations: AUTOS }) });
        expect(screen.queryByText(/not linked to this agent/)).toBeNull();
    });

    it('toont de band niet zonder gegunde automations', () => {
        renderCard();
        expect(screen.queryByTestId('agent-automations-band')).toBeNull();
    });
});


describe('ToolsCard — waarom een app kan ontbreken', () => {
    const BROWSER = {
        id: 'browser-fetch', label: 'Browse Web', available: false, actionsKnown: true,
        provider: null, requiresGrant: true,
        // Twee mogelijke oorzaken: de docker-probe en het org-entitlement.
        availabilityKind: null, availabilityKinds: ['installation', 'permission'],
        actions: [{ name: 'browse_web', label: 'browse web', effect: 'writes' }],
    };
    const NOTES = {
        id: 'notes', label: 'Notes', available: false, actionsKnown: true, provider: null,
        availabilityKind: 'installation', availabilityKinds: ['installation'],
        actions: [{ name: 'notes_read', label: 'notes read', effect: 'reads' }],
    };

    it('noemt bij MEER dan één mogelijke oorzaak geen enkele als DE reden', () => {
        renderCard({
            rows: toolRows({
                toolsConfig: null, enabledIntegrations: ['browser-fetch', 'notes'],
                apps: [BROWSER, NOTES], catalogState: READ.OK, providersKnown: true,
            }),
            apps: [BROWSER, NOTES],
        });
        const rows = screen.getAllByTestId('agent-tool-row');
        expect(within(rows[0]).getByText(/this installation may not have it, or your account may not use it/i))
            .toBeTruthy();
        // En met precies één oorzaak blijft de specifieke zin staan.
        expect(within(rows[1]).getByText(/Not available on this installation/i)).toBeTruthy();
    });
});
