import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { READ } from './canUseFacts';
import ToolChooser from './ToolChooser';

/**
 * De tool-kiezer, van klik tot config.
 *
 * `toolChooserModel.test.js` pint de rekenkant; hier staat wat de EIGENAAR
 * doet: openen, vinken, toepassen. De schil is de echte
 * `shared/AppActionPicker` — een kiezer die alleen met een nep-schil werkt,
 * bewijst niets over het scherm dat gebruikers zien.
 */

const t = (key, fallback, vars) => {
    let out = fallback ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(String(v));
    return out;
};

const APPS = [
    {
        id: 'gmail', label: 'Gmail', available: true, actionsKnown: true, provider: 'google',
        actions: [
            { name: 'gmail_search', label: 'gmail search', effect: 'reads' },
            { name: 'gmail_compose', label: 'gmail compose', effect: 'sends' },
        ],
    },
    {
        id: 'google-drive', label: 'Drive', available: true, actionsKnown: true, provider: 'google',
        actions: [
            { name: 'drive_search', label: 'drive search', effect: 'reads' },
        ],
    },
];

function renderChooser(props = {}) {
    const onCommit = vi.fn();
    const onClose = vi.fn();
    const utils = render(
        <ToolChooser
            t={t}
            open
            apps={APPS}
            catalogState={READ.OK}
            toolsConfig={null}
            enabledIntegrations={['gmail']}
            focusAppId="gmail"
            onCommit={onCommit}
            onClose={onClose}
            {...props}
        />,
    );
    return { onCommit, onClose, ...utils };
}

afterEach(cleanup);

describe('ToolChooser — wat er te kiezen valt', () => {
    it('opent een UITGEZETTE app met nul vinkjes, ook al mag hij volgens de grants alles', () => {
        renderChooser({ focusAppId: null });
        fireEvent.click(screen.getByRole('button', { name: /^Drive$/ }));
        // Eén actie, dus de ENKELVOUDSsleutel — geen "1 actions".
        expect(screen.getByText('0 of 1 action on')).toBeTruthy();
        expect(screen.getByRole('button', { name: /^drive search/ }).getAttribute('aria-pressed')).toBe('false');
    });

    it('opent een AANGEZETTE app zonder entry met al zijn acties aan — anders neemt de eerste opslag alles af', () => {
        renderChooser();
        expect(screen.getByText('2 of 2 actions on')).toBeTruthy();
    });

    it('zegt dat de app-lijst niet gelezen kon worden in plaats van een lege kiezer te tonen', () => {
        renderChooser({ catalogState: READ.ERROR, apps: null, onRetryCatalog: vi.fn() });
        expect(screen.getByTestId('agent-tool-chooser-notice')).toBeTruthy();
        expect(screen.getByTestId('agent-tool-chooser-retry')).toBeTruthy();
        // Geen "je hebt geen apps" — dat is de enige van de drie antwoorden die
        // onwaar is.
        expect(screen.queryByText(/No apps available for you yet/i)).toBeNull();
    });

    it('zegt het ook wanneer de beschikbaarheid niet nagegaan kon worden', () => {
        renderChooser({ catalogDegraded: true });
        expect(screen.getByTestId('agent-tool-chooser-degraded')).toBeTruthy();
    });
});

// ── Apps die de kiezer nooit kon tonen (A2-1) ───────────────────────
// `browse_web` zit achter een docker-probe: op de ene installatie is hij er en
// op de andere niet. AFWEZIG, NIET BESCHIKBAAR OP DEZE INSTALLATIE en NIET
// TOEGEKEND zijn drie verschillende dingen, en de kiezer mag alleen zeggen wat
// waar is — hem verzwijgen is het enige antwoord dat geen van drieën is.
describe('ToolChooser — een app die deze installatie niet heeft', () => {
    const BROWSER = {
        id: 'browser-fetch', label: 'Browse Web', available: false, actionsKnown: true,
        requiresGrant: true, availabilityKind: 'installation', provider: null,
        actions: [{ name: 'browse_web', label: 'browse web', effect: 'writes' }],
    };

    it('toont hem, en zegt dat de INSTALLATIE hem niet heeft — niet dat jij hem niet verbond', () => {
        renderChooser({ apps: [...APPS, BROWSER], focusAppId: 'browser-fetch' });
        expect(screen.getByRole('button', { name: /^Browse Web$/ })).toBeTruthy();
        expect(screen.getByText(/Browse Web is not available on this installation\./)).toBeTruthy();
        expect(screen.queryByText(/Browse Web is not connected for you/)).toBeNull();
    });

    it('opent bij een GECUREERDE agent met nul vinkjes — de runtime gunt hem daar ook niets', () => {
        renderChooser({
            apps: [...APPS, BROWSER],
            focusAppId: 'browser-fetch',
            toolsConfig: { gmail: { actions: ['gmail_search'] } },
            enabledIntegrations: ['gmail', 'browser-fetch'],
        });
        expect(screen.getByText('0 of 1 action on')).toBeTruthy();
    });

    it('en aanvinken schrijft een ECHTE grant weg', () => {
        const { onCommit } = renderChooser({
            apps: [...APPS, BROWSER],
            focusAppId: 'browser-fetch',
            toolsConfig: { gmail: { actions: ['gmail_search'] } },
            enabledIntegrations: ['gmail', 'browser-fetch'],
        });
        fireEvent.click(screen.getByRole('button', { name: /^browse web/ }));
        fireEvent.click(screen.getByTestId('agent-tool-chooser-apply'));

        const out = onCommit.mock.calls[0][0];
        expect(out.tools['browser-fetch'].actions).toBe('*');
        expect(out.tools.gmail).toEqual({ actions: ['gmail_search'] });
    });
});

describe('ToolChooser — toepassen', () => {
    it('schrijft pas bij "toepassen", en dan in ÉÉN keer', () => {
        const { onCommit } = renderChooser();
        fireEvent.click(screen.getByRole('button', { name: /^gmail compose/ }));   // uitvinken
        expect(onCommit).not.toHaveBeenCalled();

        fireEvent.click(screen.getByTestId('agent-tool-chooser-apply'));
        expect(onCommit).toHaveBeenCalledTimes(1);
        const out = onCommit.mock.calls[0][0];
        expect(out.tools.gmail.actions).toEqual(['gmail_search']);
        expect(out.enabledIntegrations).toEqual(['gmail']);
    });

    it('zet een app AAN zodra er iets van aangevinkt wordt', () => {
        const { onCommit } = renderChooser();
        fireEvent.click(screen.getByRole('button', { name: /^Drive$/ }));
        fireEvent.click(screen.getByRole('button', { name: /^drive search/ }));
        fireEvent.click(screen.getByTestId('agent-tool-chooser-apply'));

        const out = onCommit.mock.calls[0][0];
        expect(out.enabledIntegrations).toEqual(['gmail', 'google-drive']);
        expect(out.tools['google-drive'].actions).toBe('*');
    });

    it('alles uitvinken zet de app uit én schrijft de weigering weg', () => {
        const { onCommit } = renderChooser();
        fireEvent.click(screen.getByRole('button', { name: /^Switch all off$/i }));
        fireEvent.click(screen.getByTestId('agent-tool-chooser-apply'));

        const out = onCommit.mock.calls[0][0];
        expect(out.tools.gmail.actions).toEqual([]);
        expect(out.enabledIntegrations).toEqual([]);
    });

    it('doet niets als er niets veranderde — openen en sluiten is geen keuze', () => {
        const { onCommit } = renderChooser();
        const apply = screen.getByTestId('agent-tool-chooser-apply');
        expect(apply.textContent).toMatch(/Nothing to change/i);
        expect(apply.hasAttribute('disabled')).toBe(true);
        fireEvent.click(apply);
        expect(onCommit).not.toHaveBeenCalled();
    });

    it('telt erbij en eraf apart op de knop', () => {
        renderChooser();
        fireEvent.click(screen.getByRole('button', { name: /^gmail compose/ }));
        expect(screen.getByTestId('agent-tool-chooser-apply').textContent).toMatch(/Remove 1 tool$/);
    });
});

describe('ToolChooser — de eerste curatie', () => {
    it('waarschuwt dat deze agent vanaf nu alleen krijgt wat hier aanstaat', () => {
        renderChooser();
        expect(screen.queryByTestId('agent-tool-chooser-first-curation')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: /^gmail compose/ }));
        expect(screen.getByTestId('agent-tool-chooser-first-curation')).toBeTruthy();
    });

    it('waarschuwt NIET voor een agent die al gecureerd is — dan verandert er geen regime', () => {
        renderChooser({ toolsConfig: { gmail: { actions: ['gmail_search', 'gmail_compose'] } } });
        fireEvent.click(screen.getByRole('button', { name: /^gmail compose/ }));
        expect(screen.queryByTestId('agent-tool-chooser-first-curation')).toBeNull();
    });
});

describe('ToolChooser — de gefaseerde selectie overleeft de ouder', () => {
    it('houdt de vinkjes vast als de EDITOR opnieuw tekent', () => {
        // De editor tekent opnieuw bij van alles wat niets met de kiezer te
        // maken heeft (een opslagstatus, een binnenkomende lezing, een
        // relatieve tijd). Hij geeft daarbij verse `apps`- en `labels`-objecten
        // door. Als de kiezer daarop opnieuw uitgaat van de config, veegt hij
        // weg waar iemand middenin staat — en dat is precies het soort verlies
        // dat je pas merkt als je op "toepassen" drukt.
        const props = {
            t, open: true, focusAppId: 'gmail', catalogState: READ.OK,
            toolsConfig: null, enabledIntegrations: ['gmail'],
            onCommit: vi.fn(), onClose: vi.fn(),
        };
        const { rerender } = render(<ToolChooser {...props} apps={APPS} labels={{ gmail: 'Gmail' }} />);
        fireEvent.click(screen.getByRole('button', { name: /^gmail compose/ }));
        expect(screen.getByTestId('agent-tool-chooser-apply').textContent).toMatch(/Remove 1 tool/);

        // Zelfde apps, nieuwe objecten — zoals een ouder die hertekent.
        rerender(<ToolChooser {...props} apps={APPS.map(a => ({ ...a }))} labels={{ gmail: 'Gmail' }} />);
        expect(screen.getByRole('button', { name: /^gmail compose/ }).getAttribute('aria-pressed')).toBe('false');
        expect(screen.getByTestId('agent-tool-chooser-apply').textContent).toMatch(/Remove 1 tool/);
    });
});

describe('ToolChooser — alleen-lezen', () => {
    it('toont wat er aanstaat, maar biedt geen knop die de server toch weigert', () => {
        const { onCommit } = renderChooser({ ro: true });
        // De stand is te zien...
        expect(screen.getByText('2 of 2 actions on')).toBeTruthy();
        // ...maar er is niets te veranderen en niets te bevestigen.
        expect(screen.getByTestId('agent-tool-chooser-readonly')).toBeTruthy();
        expect(screen.queryByTestId('agent-tool-chooser-apply')).toBeNull();
        expect(screen.queryByRole('button', { name: /^Switch all off$/i })).toBeNull();

        const row = screen.getByRole('button', { name: /^gmail compose/ });
        expect(row.hasAttribute('disabled')).toBe(true);
        fireEvent.click(row);
        expect(row.getAttribute('aria-pressed')).toBe('true');
        expect(onCommit).not.toHaveBeenCalled();
    });
});
