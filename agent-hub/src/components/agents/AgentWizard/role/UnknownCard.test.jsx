/**
 * UnknownCard — "Als het niet weet" (A3 deel A).
 *
 * De harde eis: een routinelijst die niet gelezen kon worden is NIET "geen
 * routines". Dat onderscheid is de reden dat de kaart een `READ`-toestand
 * krijgt in plaats van alleen een array.
 *
 * Run: cd agent-hub && ./node_modules/.bin/vitest run src/components/agents/AgentWizard/role/UnknownCard.test.jsx
 */
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';

import { READ } from './personaFacts';
import UnknownCard from './UnknownCard';

const t = (key, fallback, params) => {
    let s = typeof fallback === 'string' ? fallback : key;
    for (const [k, v] of Object.entries(params || {})) s = s.split(`{${k}}`).join(String(v));
    return s;
};

const persona = (mode = 'honest', automationId = null) => ({
    who: '', tone: { chips: [], text: '' }, does: [], doesNot: [],
    unknown: { mode, automationId }, language: null, mode: 'fields', freeText: '',
});

const CALLABLE = { id: 'a1', title: 'Pass the question on', isActive: true, definition: { trigger: { kind: 'agent_call' } } };
const SCHEDULED = { id: 'a2', title: 'Nightly report', isActive: true, definition: { trigger: { kind: 'schedule' } } };
const OFF = { id: 'a3', title: 'Old handover', isActive: false, triggerKind: 'agent_call' };

const mine = { agentOwnerId: 'u1', userId: 'u1' };

afterEach(() => cleanup());

describe('UnknownCard — de drie keuzes', () => {
    it('is een echte radiogroup met de drie modi van de server', () => {
        render(<UnknownCard t={t} persona={persona('web')} {...mine} />);
        const group = screen.getByRole('radiogroup');
        const radios = screen.getAllByRole('radio');
        expect(radios).toHaveLength(3);
        expect(group.getAttribute('aria-label')).toBe("If it doesn't know");
        expect(radios.map(r => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    });

    it('meldt bij "zeg eerlijk" het neveneffect zoals de server het doet — alleen mét KENNISBANK', () => {
        // `applyPersonaToConfig` zet `strictKnowledge` alleen als de agent een
        // KENNISBANK heeft (`config.knowledge_base_ids`); een tabelgrant telt
        // daar niet, omdat knowledgeSearch.js de KNOWLEDGE BASE RESULTS-sectie
        // alleen uit die sleutel bouwt en de agent anders ALLES zou weigeren.
        // De omschrijving mag dus geen bredere "kennis" beloven.
        render(<UnknownCard t={t} persona={persona('honest')} {...mine} />);
        const desc = screen.getByText(/knowledge base linked/i);
        expect(desc.textContent).toMatch(/a table on its own does not count here/i);
    });

    it('zegt bij "zoek op het web" dat de app aan moet staan', () => {
        render(<UnknownCard t={t} persona={persona('web')} {...mine} />);
        expect(screen.getByText(/asks for the web-search app/i)).toBeTruthy();
    });

    it('geeft een moduswissel door', () => {
        const onChangeMode = vi.fn();
        render(<UnknownCard t={t} persona={persona('honest')} onChangeMode={onChangeMode} {...mine} />);
        fireEvent.click(screen.getAllByRole('radio')[2]);
        expect(onChangeMode).toHaveBeenCalledWith('handoff');
    });

    it('tekent de routinekiezer alleen in handoff-modus', () => {
        const { rerender } = render(<UnknownCard t={t} persona={persona('honest')} automations={[CALLABLE]} {...mine} />);
        expect(screen.queryByTestId('agent-role-handoff-select')).toBeNull();
        rerender(<UnknownCard t={t} persona={persona('handoff')} automations={[CALLABLE]} {...mine} />);
        expect(screen.getByTestId('agent-role-handoff-select')).toBeTruthy();
    });
});

describe('UnknownCard — onleesbaar is geen "geen routines"', () => {
    it('zegt bij een mislukte lezing dat het onbekend is, en niet dat er niets is', () => {
        render(<UnknownCard t={t} persona={persona('handoff')} automations={null} automationsState={READ.ERROR} {...mine} />);
        const note = screen.getByTestId('agent-role-handoff-unreadable-list');
        expect(note.textContent).toMatch(/could not be read/i);
        expect(note.textContent).toMatch(/not the same as having none/i);
        expect(screen.queryByTestId('agent-role-handoff-empty')).toBeNull();
        expect(screen.queryByTestId('agent-role-handoff-select')).toBeNull();
    });

    it('zegt tijdens het laden niets over aantallen', () => {
        render(<UnknownCard t={t} persona={persona('handoff')} automations={null} automationsState={READ.LOADING} {...mine} />);
        expect(screen.getByTestId('agent-role-handoff-loading')).toBeTruthy();
        expect(screen.queryByTestId('agent-role-handoff-empty')).toBeNull();
        expect(screen.queryByTestId('agent-role-handoff-unreadable-list')).toBeNull();
    });

    it('zegt "geen" pas als de lezing gelukt is', () => {
        render(<UnknownCard t={t} persona={persona('handoff')} automations={[SCHEDULED]} automationsState={READ.OK} {...mine} />);
        expect(screen.getByTestId('agent-role-handoff-empty').textContent).toMatch(/trigger is an agent call/i);
    });

    it('de STANDAARDWAARDEN zijn onleesbaar, niet leeg — één kaart mag zichzelf niet tegenspreken', () => {
        // Zonder automations-props (`automations = null, automationsState =
        // READ.OK`) zei deze kaart tegelijk "No routine can be started by an
        // agent yet" én "This routine could not be read here". Dat is de nul
        // die niemand gemeten heeft, in de module die daar juist tegen bestaat
        // — en dat is precies de plek waar de bedrading vergeten kan worden.
        render(<UnknownCard t={t} persona={persona('handoff', 'a1')} {...mine} />);
        expect(screen.getByTestId('agent-role-handoff-unreadable-list')).toBeTruthy();
        expect(screen.queryByTestId('agent-role-handoff-empty')).toBeNull();
        expect(screen.getByTestId('agent-role-handoff-unreadable')).toBeTruthy();
    });

    it('zet de wisselende takken in één aria-live-blok', () => {
        render(<UnknownCard t={t} persona={persona('handoff')} automations={null} automationsState={READ.ERROR} {...mine} />);
        const live = document.querySelector('[aria-live="polite"]');
        expect(live).toBeTruthy();
        expect(live.contains(screen.getByTestId('agent-role-handoff-unreadable-list'))).toBe(true);
    });

    it('ÉÉN live region: de notities BINNEN het blok dragen geen eigen rol', () => {
        // Twee live regions genest laat de schermlezer dezelfde zin twee keer
        // voorlezen. De notities BUITEN het blok (de pil eronder) houden hun
        // `role="status"` wél — daar is niets omheen dat al aankondigt.
        render(<UnknownCard t={t} persona={persona('handoff', 'a1')} automations={null} automationsState={READ.ERROR} {...mine} />);
        const live = document.querySelector('[aria-live="polite"]');
        expect(live.querySelector('[role="status"]')).toBeNull();
        expect(screen.getByTestId('agent-role-handoff-unreadable').getAttribute('role')).toBe('status');
    });
});

describe('UnknownCard — de agent_call-poort en het eigenaarschap', () => {
    it('biedt alleen agent_call-routines aan', () => {
        render(<UnknownCard t={t} persona={persona('handoff')} automations={[CALLABLE, SCHEDULED]} {...mine} />);
        const options = [...screen.getByTestId('agent-role-handoff-select').options].map(o => o.value);
        expect(options).toEqual(['', 'a1']);
    });

    it('laat een uitgeschakelde routine weg uit de keuzes en zegt dat hij bestaat', () => {
        render(<UnknownCard t={t} persona={persona('handoff')} automations={[CALLABLE, OFF]} {...mine} />);
        const options = [...screen.getByTestId('agent-role-handoff-select').options].map(o => o.value);
        expect(options).toEqual(['', 'a1']);
        expect(screen.getByTestId('agent-role-handoff-switched-off').textContent)
            .toBe('1 routine is switched off and is not offered here.');
    });

    it('gebruikt de meervoudsleutel bij meer dan één', () => {
        render(<UnknownCard t={t} persona={persona('handoff')} automations={[CALLABLE, OFF, { ...OFF, id: 'a4' }]} {...mine} />);
        expect(screen.getByTestId('agent-role-handoff-switched-off').textContent)
            .toBe('2 routines are switched off and are not offered here.');
    });

    it('noemt de aan/uit-schakelaar, niet de trigger, als ALLE routines uit staan', () => {
        // De lege tak koos op `offered.length === 0` en noemde dan de trigger
        // als reden terwijl de trigger juist klopte, met één regel lager de
        // tegenspraak "2 routines are switched off". Twee zinnen die elkaar
        // tegenspreken, en de eerste stuurde de eigenaar naar het verkeerde
        // scherm.
        render(<UnknownCard t={t} persona={persona('handoff')} automations={[OFF, { ...OFF, id: 'a4' }]} {...mine} />);
        expect(screen.queryByTestId('agent-role-handoff-empty')).toBeNull();
        expect(screen.getByTestId('agent-role-handoff-all-off').textContent)
            .toBe('All 2 routines an agent could start are switched off, so there is nothing to hand over to. Switch one back on first.');
        expect(screen.queryByTestId('agent-role-handoff-switched-off')).toBeNull();
    });

    it('gebruikt ook daar de enkelvoudsleutel bij precies één', () => {
        render(<UnknownCard t={t} persona={persona('handoff')} automations={[OFF]} {...mine} />);
        expect(screen.getByTestId('agent-role-handoff-all-off').textContent)
            .toBe('The one routine an agent could start is switched off, so there is nothing to hand over to. Switch it back on first.');
    });

    it('telt geen uitgeschakelde routines op ANDERMANS agent', () => {
        // `GET /api/automation` geeft de routines van de INGELOGDE gebruiker.
        // Die telling onder andermans agent zetten presenteert een feit over
        // jouw lijst als een feit over zijn agent.
        render(<UnknownCard t={t} persona={persona('handoff')} automations={[CALLABLE, OFF]} agentOwnerId="u2" userId="u1" />);
        expect(screen.getByTestId('agent-role-handoff-blocked')).toBeTruthy();
        expect(screen.queryByTestId('agent-role-handoff-switched-off')).toBeNull();
        expect(screen.queryByTestId('agent-role-handoff-all-off')).toBeNull();
    });

    it('kiest niet voor andermans agent — de server toetst op de EIGENAAR', () => {
        render(<UnknownCard t={t} persona={persona('handoff')} automations={[CALLABLE]} agentOwnerId="u2" userId="u1" />);
        expect(screen.queryByTestId('agent-role-handoff-select')).toBeNull();
        expect(screen.getByTestId('agent-role-handoff-blocked').textContent).toMatch(/checked against its owner/i);
    });

    it('versmalt ook wanneer de eigenaar onbekend is', () => {
        render(<UnknownCard t={t} persona={persona('handoff')} automations={[CALLABLE]} />);
        expect(screen.queryByTestId('agent-role-handoff-select')).toBeNull();
        expect(screen.getByTestId('agent-role-handoff-blocked').textContent).toMatch(/not known here/i);
    });

    it('geeft een keuze door aan de ouder', () => {
        const onChangeHandoff = vi.fn();
        render(<UnknownCard t={t} persona={persona('handoff')} automations={[CALLABLE]} onChangeHandoff={onChangeHandoff} {...mine} />);
        fireEvent.change(screen.getByTestId('agent-role-handoff-select'), { target: { value: 'a1' } });
        expect(onChangeHandoff).toHaveBeenCalledWith('a1');
    });
});

describe('UnknownCard — de pil van de gekozen routine', () => {
    it('noemt de routine bij naam', () => {
        render(<UnknownCard t={t} persona={persona('handoff', 'a1')} automations={[CALLABLE]} {...mine} />);
        expect(screen.getByTestId('agent-role-handoff-pill').textContent).toBe('Pass the question on');
    });

    it('houdt een onleesbare routine zichtbaar in plaats van hem te ontkennen', () => {
        render(<UnknownCard t={t} persona={persona('handoff', 'a1')} automations={null} automationsState={READ.ERROR} {...mine} />);
        expect(screen.getByTestId('agent-role-handoff-pill').textContent).toBe('a1');
        expect(screen.getByTestId('agent-role-handoff-unreadable').textContent).toMatch(/has not gone away/i);
    });

    it('waarschuwt over een routine die uit staat', () => {
        render(<UnknownCard t={t} persona={persona('handoff', 'a3')} automations={[OFF]} {...mine} />);
        expect(screen.getByTestId('agent-role-handoff-inactive').textContent).toMatch(/says it does not know instead/i);
    });

    it('waarschuwt over een routine die geen agent_call meer is', () => {
        render(<UnknownCard t={t} persona={persona('handoff', 'a2')} automations={[SCHEDULED]} {...mine} />);
        expect(screen.getByTestId('agent-role-handoff-not-callable').textContent).toMatch(/never offered it/i);
    });

    it('zegt dat handoff zonder routine terugvalt op eerlijk zijn', () => {
        render(<UnknownCard t={t} persona={persona('handoff')} automations={[CALLABLE]} {...mine} />);
        expect(screen.getByTestId('agent-role-handoff-none').textContent).toMatch(/says it does not know instead/i);
    });
});
