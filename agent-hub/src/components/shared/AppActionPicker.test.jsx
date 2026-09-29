import { fireEvent, render, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import AppActionPicker from './AppActionPicker';

/**
 * The one app menu, shared by the agent editor's tool picker and App Studio's
 * connector picker. These tests cover the shell itself — the behaviours both
 * surfaces inherit, so a change here can't silently regress one of them.
 */

const APPS = [
    {
        id: 'gmail', label: 'Gmail', available: true,
        actions: [
            { name: 'gmail_search', label: 'Search', description: 'Find messages', producesList: true },
            { name: 'gmail_send', label: 'Send email', description: 'Send a message', sideEffect: true },
        ],
    },
    {
        id: 'slack', label: 'Slack', available: false,
        actions: [{ name: 'slack_post', label: 'Post message' }],
    },
];

function renderPicker(props = {}) {
    const onToggle = vi.fn();
    const onToggleApp = vi.fn();
    const onClose = vi.fn();
    const utils = render(
        <AppActionPicker apps={APPS} selected={[]} onToggle={onToggle} onToggleApp={onToggleApp} onClose={onClose} {...props} />,
    );
    return { onToggle, onToggleApp, onClose, ...utils };
}

describe('AppActionPicker', () => {
    it('opens on the first app and lists its actions', () => {
        const { getByRole } = renderPicker();
        expect(getByRole('button', { name: /^Search/ })).toBeTruthy();
        expect(getByRole('button', { name: /^Send email/ })).toBeTruthy();
    });

    it('toggles one action and reports which app it belonged to', () => {
        const { getByRole, onToggle } = renderPicker();
        fireEvent.click(getByRole('button', { name: /^Search/ }));
        const [name, app, action] = onToggle.mock.calls[0];
        expect(name).toBe('gmail_search');
        expect(app.id).toBe('gmail');
        expect(action.label).toBe('Search');
    });

    it('shows how many of an app’s actions are selected, on the row and in the header', () => {
        const { getByRole, getByLabelText, getByText } = renderPicker({ selected: ['gmail_search'] });
        expect(getByLabelText('1 selected')).toBeTruthy();
        expect(getByText(/1 of 2 actions selected/i)).toBeTruthy();
        expect(getByRole('button', { name: /^Search/ }).getAttribute('aria-pressed')).toBe('true');
    });

    it('enables and disables a whole app at once', () => {
        const { getByRole, onToggleApp } = renderPicker();
        fireEvent.click(getByRole('button', { name: /enable all/i }));
        expect(onToggleApp.mock.calls[0][1]).toBe(true);
    });

    it('flips "Enable all" to "Disable all" when everything is already on', () => {
        const { getByRole } = renderPicker({ selected: ['gmail_search', 'gmail_send'] });
        expect(getByRole('button', { name: /disable all/i })).toBeTruthy();
    });

    it('badges list-producing and writing actions', () => {
        const { getByRole } = renderPicker();
        expect(getByRole('button', { name: /^Search/ }).textContent).toMatch(/list/i);
        expect(getByRole('button', { name: /^Send email/ }).textContent).toMatch(/writes/i);
    });

    it('searching narrows the RIGHT pane too, not just the app list', () => {
        // Searching "send" and still having to hunt through 15 Gmail actions
        // would defeat the point.
        const { getByLabelText, getByRole, queryByRole } = renderPicker();
        fireEvent.change(getByLabelText('Search apps and actions'), { target: { value: 'send' } });
        expect(getByRole('button', { name: /^Send email/ })).toBeTruthy();
        expect(queryByRole('button', { name: /^Search\b/ })).toBeNull();
    });

    it('keeps an unconnected app visible and explains what that means', () => {
        // Hiding it is what makes a picker feel broken ("where is Slack?").
        const { getByRole, getByText } = renderPicker({ unavailableHint: 'not connected to your account' });
        fireEvent.click(getByRole('button', { name: /^Slack$/ }));
        expect(getByText(/Slack is not connected to your account/i)).toBeTruthy();
        expect(getByRole('button', { name: /^Post message/ })).toBeTruthy();
    });

    it('closes on Escape and on the backdrop', () => {
        const { onClose, getByRole } = renderPicker();
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
        fireEvent.click(getByRole('button', { name: /^Close$/ }));
        expect(onClose).toHaveBeenCalledTimes(2);
    });

    it('renders a footer when the caller supplies one (the connector Apply bar)', () => {
        const { getByRole } = renderPicker({ footer: <button type="button">Apply</button> });
        expect(getByRole('button', { name: 'Apply' })).toBeTruthy();
    });

    it('says so rather than rendering an empty shell when there are no apps', () => {
        const { getAllByText } = render(
            <AppActionPicker apps={[]} selected={[]} onToggle={vi.fn()} onClose={vi.fn()} emptyLabel="No apps available" />,
        );
        expect(getAllByText('No apps available').length).toBeGreaterThan(0);
    });

    it('scopes selection counts per app', () => {
        const { getByText } = renderPicker({ selected: ['slack_post'] });
        // Gmail is focused and has none of them selected.
        expect(getByText(/0 of 2 actions selected/i)).toBeTruthy();
    });

    it('exposes the overlay as a labelled dialog', () => {
        const { getByRole } = renderPicker({ title: 'Choose apps & actions' });
        expect(getByRole('dialog', { name: /choose apps & actions/i })).toBeTruthy();
    });

    it('lets the caller reach an app’s actions through the left list', () => {
        const { getByRole } = renderPicker();
        fireEvent.click(getByRole('button', { name: /^Slack$/ }));
        const pane = getByRole('dialog');
        expect(within(pane).getByRole('button', { name: /^Post message/ })).toBeTruthy();
    });
});

/**
 * Het PER-APP selectiemodel en de effect-chips (A2 stap 4).
 *
 * De platte `selected`-lijst kan "over deze app is niets gezegd" en "deze app
 * mag niets" niet uit elkaar houden — bevinding 1 van de A1b-rechtenlaagreview.
 * Wat hier gepind wordt is dat de schil het per-app model wél draagt, dat een
 * app met onbekende acties niets te vinken geeft (in plaats van een leeg
 * lijstje dat "geen acties" beweert), en dat een onbekend effect onder
 * "Sends" valt — dezelfde smalle lezing als de runtime.
 */

const EFFECT_APPS = [
    {
        id: 'gmail', label: 'Gmail', available: true, actionsKnown: true,
        actions: [
            { name: 'gmail_search', label: 'Search', effect: 'reads' },
            { name: 'gmail_create_draft', label: 'Create draft', effect: 'writes' },
            { name: 'gmail_compose', label: 'Compose', effect: 'sends' },
            { name: 'gmail_mystery', label: 'Mystery' },
        ],
    },
    {
        id: 'broken', label: 'Broken app', available: true, actionsKnown: false, actions: [],
    },
];

function renderEffects(props = {}) {
    const onToggle = vi.fn();
    const utils = render(
        <AppActionPicker apps={EFFECT_APPS} selection={new Map()} onToggle={onToggle} onClose={vi.fn()} {...props} />,
    );
    return { onToggle, ...utils };
}

describe('AppActionPicker — het per-app selectiemodel', () => {
    it('laat `selection` winnen van de platte lijst', () => {
        const { getByRole } = renderEffects({
            selected: ['gmail_search'],
            selection: new Map([['gmail', new Set(['gmail_compose'])]]),
        });
        expect(getByRole('button', { name: /^Search/ }).getAttribute('aria-pressed')).toBe('false');
        expect(getByRole('button', { name: /^Compose/ }).getAttribute('aria-pressed')).toBe('true');
    });

    it('een LEGE set is een echte keuze: niets aangevinkt, en de app blijft staan', () => {
        const { getByText, queryByLabelText } = renderEffects({
            selection: new Map([['gmail', new Set()]]),
        });
        expect(getByText(/0 of 4 actions selected/i)).toBeTruthy();
        // Geen telbadge in de app-lijst — nul is nul, niet "niets gezegd".
        expect(queryByLabelText(/selected$/)).toBeNull();
    });

    it('een app met ONBEKENDE acties biedt niets te vinken en zegt waarom', () => {
        const { getByRole, getByTestId, queryByRole } = renderEffects();
        fireEvent.click(getByRole('button', { name: /^Broken app$/ }));
        expect(getByTestId('app-actions-unknown')).toBeTruthy();
        // Geen "Enable all" op een app waarvan we de acties niet kennen.
        expect(queryByRole('button', { name: /enable all/i })).toBeNull();
    });
});

describe('AppActionPicker — de effect-chips', () => {
    it('filtert op wat een actie DOET', () => {
        const { getByTestId, getByRole, queryByRole } = renderEffects();
        fireEvent.click(getByTestId('action-filter-reads'));
        expect(getByRole('button', { name: /^Search/ })).toBeTruthy();
        expect(queryByRole('button', { name: /^Compose/ })).toBeNull();
    });

    it('zet een ONBEKEND effect onder "Sends" — de smalle lezing van de runtime', () => {
        const { getByTestId, getByRole, queryByRole } = renderEffects();
        fireEvent.click(getByTestId('action-filter-sends'));
        expect(getByRole('button', { name: /^Compose/ })).toBeTruthy();
        expect(getByRole('button', { name: /^Mystery/ })).toBeTruthy();
        expect(queryByRole('button', { name: /^Search/ })).toBeNull();
    });

    it('dimt een rij die kan versturen en zegt dat er eerst bevestigd wordt', () => {
        // De ZIN komt van de aanroeper: "altijd eerst bevestigen" is de regel
        // van de agent-runtime, niet van elke surface die deze schil rendert.
        const { getByRole } = renderEffects({ text: { sendsNote: 'always confirmed first' } });
        const row = getByRole('button', { name: /^Compose/ });
        expect(row.getAttribute('data-testid')).toBe('action-row-sends');
        expect(row.style.opacity).toBe('0.7');
        expect(row.textContent).toMatch(/always confirmed first/i);
        // Een leesrij blijft vol contrast.
        expect(getByRole('button', { name: /^Search/ }).getAttribute('data-testid')).toBe('action-row');
    });

    it('verzint die zin NIET op een surface die de regel niet heeft', () => {
        // De AI-stap van de automations-builder rendert dezelfde schil, maar
        // daar geldt "elke verzending wordt eerst bevestigd" niet — daar staat
        // één bevestiging vóór de eerste onbeheerde run.
        const { getByRole } = renderEffects();
        const row = getByRole('button', { name: /^Compose/ });
        expect(row.getAttribute('data-testid')).toBe('action-row-sends');
        expect(row.textContent).not.toMatch(/confirmed/i);
    });

    it('badget het effect in de themakleuren, niet in losse hexwaarden', () => {
        const { getAllByTestId } = renderEffects();
        expect(getAllByTestId('action-effect-reads')[0].style.color).toBe('var(--success)');
        expect(getAllByTestId('action-effect-writes')[0].style.color).toBe('var(--warning)');
        expect(getAllByTestId('action-effect-sends')[0].style.color).toBe('var(--error)');
        expect(getAllByTestId('action-effect-unknown')[0].style.color).toBe('var(--error)');
    });

    it('toont GEEN chips voor een catalogus zonder effecten — dan zou het filter alles verbergen', () => {
        const { queryByTestId } = render(
            <AppActionPicker apps={APPS} selected={[]} onToggle={vi.fn()} onClose={vi.fn()} />,
        );
        expect(queryByTestId('action-filter-sends')).toBeNull();
        expect(queryByTestId('action-effect-unknown')).toBeNull();
    });

    it('opent op de gevraagde app — de ↗ van een tool-rij wijst naar díé app', () => {
        const { getByRole } = renderEffects({ focusAppId: 'broken' });
        expect(getByRole('heading', { name: 'Broken app' })).toBeTruthy();
    });

    it('verspringt mee als er een NIEUW focusverzoek komt terwijl de kiezer openstaat', () => {
        // Een schil die blijft staan tussen twee ↗-klikken zou anders op de
        // eerste app blijven hangen — de tweede klik doet dan niets zichtbaars.
        const { rerender, getByRole } = render(
            <AppActionPicker apps={EFFECT_APPS} selection={new Map()} onToggle={vi.fn()} onClose={vi.fn()} focusAppId="gmail" />,
        );
        expect(getByRole('heading', { name: 'Gmail' })).toBeTruthy();
        rerender(
            <AppActionPicker apps={EFFECT_APPS} selection={new Map()} onToggle={vi.fn()} onClose={vi.fn()} focusAppId="broken" />,
        );
        expect(getByRole('heading', { name: 'Broken app' })).toBeTruthy();
    });
});
