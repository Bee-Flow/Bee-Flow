import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { READ } from './canUseFacts';
import { ACT_AS, CONFIRM, automationRows, toolRows } from './toolGrants';
import ToolsCard from './ToolsCard';

/**
 * De Tools-kaart. Wat hier gepind wordt is niet de opmaak maar de drie
 * versmallingen die de kaart met de runtime deelt — verstuurt ⇒ vergrendeld,
 * onbekend ⇒ óók vergrendeld, geen leen-grant ⇒ geen eigenaar-optie — plus de
 * regel dat een mislukte catalogus geen lege kaart oplevert.
 */

// De echte vertaler interpoleert `{placeholder}`; de tests hangen op die
// getallen, dus deze doet dat ook.
const t = (key, fallback, vars) => {
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
            rows={rowsFor()}
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

    it('opent de kiezer op DIE app', () => {
        const onOpenChooser = vi.fn();
        renderCard({ onOpenChooser });

        fireEvent.click(screen.getAllByTestId('agent-tool-open')[0]);
        expect(onOpenChooser).toHaveBeenCalledWith({ section: 'apps', appId: 'gmail' });
    });

    // A2-1: `browse_web` zit achter een docker-probe. "Deze installatie heeft
    // hem niet" is iets anders dan "jij hebt hem niet verbonden", en de kaart
    // mag alleen de zin zeggen die waar is.
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

    it('laat de keuze vrij voor een app die niets verstuurt', () => {
        renderCard();
        const drive = within(screen.getAllByTestId('agent-tool-row')[1]);
        expect(drive.getByRole('radio', { name: 'Direct' }).hasAttribute('disabled')).toBe(false);
        fireEvent.click(drive.getByRole('radio', { name: 'Confirm first' }));
    });

    it('geeft de app-id en de nieuwe waarde door', () => {
        const onChangeConfirm = vi.fn();
        renderCard({ onChangeConfirm });
        const drive = within(screen.getAllByTestId('agent-tool-row')[1]);
        fireEvent.click(drive.getByRole('radio', { name: 'Confirm first' }));
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

    it('biedt de eigenaar-optie alleen aan waar er echt geleend is', () => {
        renderCard({
            rows: rowsFor({ lentApps: new Set(['gmail', 'google-drive']), lendingEnabled: true }),
        });
        // Drive leent wél (leest en schrijft, verstuurt niet).
        const drive = within(screen.getAllByTestId('agent-tool-row')[1]);
        fireEvent.click(drive.getByTestId('agent-tool-actas'));
        expect(screen.getByTestId('agent-tool-actas-owner').hasAttribute('disabled')).toBe(false);
    });

    it('weigert de eigenaar-optie zonder leen-grant, en zegt waarom', () => {
        renderCard();
        const drive = within(screen.getAllByTestId('agent-tool-row')[1]);
        fireEvent.click(drive.getByTestId('agent-tool-actas'));
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

    it('geeft de keuze door met de app-id', () => {
        const onChangeActAs = vi.fn();
        renderCard({
            rows: rowsFor({ lentApps: new Set(['gmail', 'google-drive']), lendingEnabled: true }),
            onChangeActAs,
        });
        const drive = within(screen.getAllByTestId('agent-tool-row')[1]);
        fireEvent.click(drive.getByTestId('agent-tool-actas'));
        fireEvent.click(screen.getByTestId('agent-tool-actas-owner'));
        expect(onChangeActAs).toHaveBeenCalledWith('google-drive', ACT_AS.OWNER);
    });
});

/**
 * A2-2 — de capsule en de runtime over DEZELFDE toestand.
 *
 * `A2_2_CURATED` staat er letterlijk zo ook in
 * server/core/agentRuntime/toolPolicy.test.js, waar hij de invoer is van
 * `mayLendOwnerConnection`. Daar is het antwoord sinds A2-2 "niet lenen"; hier
 * moet het scherm dat zeggen in plaats van stil van gedrag te veranderen.
 */
const A2_2_CURATED = Object.freeze({
    // De eigenaar heeft alleen Gmail gecureerd. Over Drive heeft hij nooit iets
    // gezegd, terwijl zijn Google-verbinding wél uitgeleend is.
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
        // Drive verstuurt niets, dus de eigenaar kan het alsnog kiezen — en
        // dan hoort die weg er ook bij te staan.
        expect(notice.textContent).toContain('Choose “As: you”');
    });

    it('laat de remedie weg waar de eigenaar hem niet kan kiezen', () => {
        // Gmail verstuurt, dus "As: you" is er niet — een uitweg noemen die de
        // kiezer weigert is dezelfde belofte-zonder-dekking als het gat zelf.
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
        // De zustertak had de uitweg IN de zin gebakken, zonder de
        // `canActAsOwner`-poort: op Gmail (verstuurt) noemde de kaart een
        // menu-item dat er niet is en dat de opslag sowieso terugdraait.
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
        // De meldingen gaan over wat er nú gebeurt als iemand de agent draait,
        // en dat leest de gepubliceerde config. Kon de server dat niet zeggen
        // (`runtimeCurated: null`), dan is elke van de twee zinnen een gok.
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
        // De draft is al gecureerd (de eigenaar vinkte iets aan, nog niet
        // gepubliceerd) terwijl de live agent nog ongecureerd draait — en dus
        // nog steeds leent. De kaart hoorde dat te zeggen in plaats van
        // "hij leent niet meer".
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
    it('houdt de rijen staan als de catalogus wegvalt, met een waarschuwing erboven', () => {
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

        fireEvent.click(within(screen.getByTestId('agent-tools-unreadable')).getByRole('button'));
        expect(onRetryCatalog).toHaveBeenCalled();
    });

    it('zegt het apart wanneer de beschikbaarheid niet berekend kon worden', () => {
        renderCard({ catalogDegraded: true });
        expect(screen.getByTestId('agent-tools-degraded')).toBeTruthy();
        // Geen enkele rij mag dan "niet verbonden" beweren.
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
