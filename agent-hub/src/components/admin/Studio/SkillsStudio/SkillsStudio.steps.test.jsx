import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import React, { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RulesEditor from './RulesEditor';
import SkillStepEditor from './SkillStepEditor';

/**
 * The two editors that replaced a textarea: steps and rules.
 *
 * The claims worth pinning are the ones a free-text box could never make:
 *   - a step is an OBJECT with an id, so it survives being reordered and can
 *     be pointed at by a test result;
 *   - a reference is picked, not typed, and only from what exists;
 *   - polarity is a field with two values, not a word in the sentence, and
 *     the mark that shows it is the control that changes it;
 *   - a read-only viewer gets no affordance at all — not a disabled one.
 */

vi.mock('../../../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })),
}));

const REF_OPTIONS = {
    automation: [{ id: 'a1', name: 'Look up quote status' }],
    kb: [{ id: 'k1', name: 'Quote terms' }],
    table: [{ id: 't1', name: 'Pricelist' }],
};

/** useSkillPickerData's answer when all four reads came back. */
const LISTS_READ = { loaded: true, unavailable: [] };

function Harness({ initial = [], readOnly = false, refOptions = REF_OPTIONS, listStatus = LISTS_READ, onSteps, onOpenRef }) {
    const [steps, setSteps] = useState(initial);
    return (
        <SkillStepEditor
            steps={steps}
            readOnly={readOnly}
            refOptions={refOptions}
            listStatus={listStatus}
            onOpenRef={onOpenRef}
            onChange={(next) => { setSteps(next); onSteps?.(next); }}
        />
    );
}

function RulesHarness({ initial = [], readOnly = false, onRules }) {
    const [rules, setRules] = useState(initial);
    return (
        <RulesEditor
            rules={rules}
            readOnly={readOnly}
            onChange={(next) => { setRules(next); onRules?.(next); }}
        />
    );
}

beforeEach(() => { cleanup(); vi.clearAllMocks(); });
// `measureCardsAsAStack` hangt een spy op Element.prototype; zonder dit lekt
// die geometrie naar elke volgende test in dit bestand.
afterEach(() => { vi.restoreAllMocks(); });

/**
 * ── DE KAARTEN EEN ECHTE GEOMETRIE GEVEN ─────────────────────────────
 * jsdom meet niets: elke getBoundingClientRect is 0x0. dnd-kit leest uit
 * ECHTE rechthoeken waar een pijltoets heen wijst — `sortableKeyboardCoordinates`
 * vergelijkt de bovenkanten van de vakjes en kiest het dichtstbijzijnde in die
 * richting — dus met louter nullen wijst elke pijl nergens heen en zou de test
 * groen blijven om de verkeerde reden. De kaarten krijgen daarom de geometrie
 * die een browser ze zou geven: een stapel rijen in DOM-volgorde, zo hoog als
 * een echte stapkaart met een textarea erin. Verder wordt er niets nagebootst.
 *
 * Die hoogte is niet vrijblijvend. dnd-kit's EIGEN standaard-coordinateGetter
 * schuift een vast aantal pixels per aanslag; alleen `sortableKeyboardCoordinates`
 * springt naar het buurvakje, hoe hoog dat ook is. Met rijen van 40px slagen
 * ze allebei en houdt de test de keuze niet vast — bij een realistische
 * kaarthoogte komt de standaard niet over de rand en deze wel.
 */
const CARD_HEIGHT = 96;
const NO_RECT = { x: 0, y: 0, top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, toJSON() {} };

function measureCardsAsAStack() {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function measured() {
        if (!this.matches?.('[data-step-id]')) return { ...NO_RECT };
        const top = Array.prototype.indexOf.call(this.parentElement.children, this) * CARD_HEIGHT;
        return { x: 0, y: top, top, bottom: top + CARD_HEIGHT, left: 0, right: 240, width: 240, height: CARD_HEIGHT, toJSON() {} };
    });
}

/**
 * dnd-kit hangt zijn keydown-luisteraar pas in een `setTimeout` op na het
 * oppakken, en meet de vakjes in een frame. Tussen twee toetsaanslagen moet
 * de macrotaak-wachtrij dus leeglopen.
 */
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 30)); });

describe('steps', () => {
    it('adds a step with an id of its own, so nothing is keyed by position', () => {
        const onSteps = vi.fn();
        render(<Harness onSteps={onSteps} />);
        fireEvent.click(screen.getByTestId('skill-step-add'));
        const [next] = onSteps.mock.calls.at(-1);
        expect(next).toHaveLength(1);
        expect(next[0].id).toMatch(/^step_/);
        expect(next[0]).toEqual({ id: next[0].id, text: '', refs: [] });
    });

    it('numbers the cards from their position, not from what was typed', () => {
        render(<Harness initial={[
            { id: 'a', text: 'first', refs: [] },
            { id: 'b', text: 'second', refs: [] },
        ]} />);
        const cards = screen.getAllByTestId('skill-step');
        expect(within(cards[0]).getByText('1')).toBeTruthy();
        expect(within(cards[1]).getByText('2')).toBeTruthy();
    });

    it('edits a step in place without disturbing its neighbours', () => {
        const onSteps = vi.fn();
        render(<Harness
            initial={[{ id: 'a', text: 'one', refs: [] }, { id: 'b', text: 'two', refs: [] }]}
            onSteps={onSteps}
        />);
        fireEvent.change(screen.getByDisplayValue('one'), { target: { value: 'ONE' } });
        const [next] = onSteps.mock.calls.at(-1);
        expect(next.map(s => s.text)).toEqual(['ONE', 'two']);
        expect(next[1]).toEqual({ id: 'b', text: 'two', refs: [] });
    });

    it('removes the step that was asked for, by id', () => {
        const onSteps = vi.fn();
        render(<Harness
            initial={[{ id: 'a', text: 'one', refs: [] }, { id: 'b', text: 'two', refs: [] }]}
            onSteps={onSteps}
        />);
        const cards = screen.getAllByTestId('skill-step');
        fireEvent.click(within(cards[0]).getByRole('button', { name: /Remove step/i }));
        expect(onSteps.mock.calls.at(-1)[0].map(s => s.id)).toEqual(['b']);
    });

    /**
     * ── HET TOETSENBORD IS DE HELE TEST ──────────────────────────────
     * Hier stond een test die keek of de grip een NAAM had ("Reorder step
     * 1") en dat "reachable without a mouse" noemde. Dat bewijst niets: met
     * de KeyboardSensor uit `useSensors` gesloopt bleef de hele SkillsStudio-map
     * groen — destijds 106 van de 106. @dnd-kit KAN toetsenbordslepen, maar
     * alleen als je die sensor aanzet, en een herordening die alleen met de
     * muis kan is voor een deel van de gebruikers geen functie.
     *
     * Dus wordt de herordening hier ECHT gedaan: Space pakt op, ArrowDown
     * verplaatst, Space legt neer. Wat de assertie vasthoudt is de UITKOMST
     * (`onChange` krijgt de nieuwe volgorde), niet de weg erheen.
     *
     * TWEE aanslagen, niet één. Een stap één plek opschuiven is een wissel
     * van buren, en die is symmetrisch: `moveItem(rows, 0, 1)` en
     * `moveItem(rows, 1, 0)` geven allebei ['b','a','c'], dus een omgedraaide
     * van/naar zou ongemerkt door de test glippen. Over twee plekken lopen de
     * twee uit elkaar (['b','c','a'] tegen ['c','a','b']) — en het bewijst
     * meteen dat de greep een tweede verplaatsing overleeft.
     */
    it('reorders with the keyboard alone: space picks a step up, arrows move it, space drops it', async () => {
        const onSteps = vi.fn();
        measureCardsAsAStack();
        render(<Harness
            initial={[
                { id: 'a', text: 'one', refs: [] },
                { id: 'b', text: 'two', refs: [] },
                { id: 'c', text: 'three', refs: [] },
            ]}
            onSteps={onSteps}
        />);

        // De grip is bewust de ENIGE activator (setActivatorNodeRef): de kaart
        // bevat een textarea, en dnd-kit weigert een start die van een ander
        // element komt. Vandaar de grip van kaart 1, en niet de kaart zelf.
        const grip = within(screen.getAllByTestId('skill-step')[0]).getByTestId('skill-step-grip');
        grip.focus();
        fireEvent.keyDown(grip, { key: ' ', code: 'Space' });
        await settle();
        fireEvent.keyDown(grip, { key: 'ArrowDown', code: 'ArrowDown' });
        await settle();
        fireEvent.keyDown(grip, { key: 'ArrowDown', code: 'ArrowDown' });
        await settle();
        fireEvent.keyDown(grip, { key: ' ', code: 'Space' });
        await settle();

        expect(onSteps).toHaveBeenCalledTimes(1);
        expect(onSteps.mock.calls.at(-1)[0].map(s => s.id)).toEqual(['b', 'c', 'a']);
    });

    /**
     * Escape laat de lijst staan zoals hij stond. Zonder deze test zou een
     * "afbreken" dat tóch opslaat er hetzelfde uitzien als een geslaagde
     * herordening — en juist bij toetsenbordbediening is afbreken de manier
     * waarop je uit een greep komt die je per ongeluk begon.
     */
    it('leaves the order alone when the keyboard drag is cancelled', async () => {
        const onSteps = vi.fn();
        measureCardsAsAStack();
        render(<Harness
            initial={[{ id: 'a', text: 'one', refs: [] }, { id: 'b', text: 'two', refs: [] }]}
            onSteps={onSteps}
        />);

        const grip = within(screen.getAllByTestId('skill-step')[0]).getByTestId('skill-step-grip');
        grip.focus();
        fireEvent.keyDown(grip, { key: ' ', code: 'Space' });
        await settle();
        // Eerst vastleggen dat er ÍETS is om af te breken. Zonder dit blijft
        // deze test groen als de hele toetsenbordbediening verdwijnt: hij houdt
        // alleen vast DAT er niets gebeurde, en als er niets KAN gebeuren is
        // dat vanzelf waar. dnd-kit's live-regio (aria-live, niet de statische
        // instructietekst) meldt de greep zodra een sensor hem oppakt; zonder
        // KeyboardSensor blijft die regio leeg en valt deze test om.
        const announced = () => [...document.querySelectorAll('[aria-live]')]
            .map(el => el.textContent).join(' ');
        expect(announced(), 'de greep is niet opgepakt — er valt niets af te breken')
            .toMatch(/Draggable item/i);
        fireEvent.keyDown(grip, { key: 'ArrowDown', code: 'ArrowDown' });
        await settle();
        fireEvent.keyDown(grip, { key: 'Escape', code: 'Escape' });
        await settle();

        expect(onSteps).not.toHaveBeenCalled();
        expect(screen.getAllByTestId('skill-step').map(el => el.getAttribute('data-step-id')))
            .toEqual(['a', 'b']);
    });

    it('names the drag handle per card, so the grip says WHICH step it moves', () => {
        render(<Harness initial={[{ id: 'a', text: 'one', refs: [] }, { id: 'b', text: 'two', refs: [] }]} />);
        expect(screen.getByRole('button', { name: 'Reorder step 1' })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Reorder step 2' })).toBeTruthy();
    });

    it('picks a reference from what exists — never free text — and shows its name', () => {
        const onSteps = vi.fn();
        render(<Harness initial={[{ id: 'a', text: 'Fetch it', refs: [] }]} onSteps={onSteps} />);
        fireEvent.click(screen.getByTestId('skill-step-ref-add'));
        fireEvent.click(screen.getByRole('menuitem', { name: /Look up quote status/ }));
        const [next] = onSteps.mock.calls.at(-1);
        expect(next[0].refs).toEqual([{ kind: 'automation', id: 'a1' }]);
    });

    it('does not offer a reference the step already carries', () => {
        render(<Harness initial={[{ id: 'a', text: 'x', refs: [{ kind: 'kb', id: 'k1' }] }]} />);
        fireEvent.click(screen.getByTestId('skill-step-ref-add'));
        expect(screen.queryByRole('menuitem', { name: /Quote terms/ })).toBeNull();
        expect(screen.getByRole('menuitem', { name: /Pricelist/ })).toBeTruthy();
    });

    /**
     * ── DRIE ANTWOORDEN, NIET TWEE ───────────────────────────────────
     * Deze test stuurde `refOptions={{}}` en niets anders. Drie lege arrays
     * kunnen "gelezen en leeg" en "nooit gelezen" niet uit elkaar houden, dus
     * hij legde het foute gedrag vast: het menu beweerde dat de organisatie
     * niets had om naar te verwijzen, óók als de lijsten nooit gelezen waren.
     * Een `table`-ref is een echte grant (datatable_query), dus wie dat te
     * horen krijgt loopt weg van een grant die hij nodig heeft.
     */
    it('offers nothing to reference only when the lists were READ and are empty', () => {
        render(<Harness initial={[{ id: 'a', text: 'x', refs: [] }]} refOptions={{}} listStatus={LISTS_READ} />);
        fireEvent.click(screen.getByTestId('skill-step-ref-add'));
        expect(screen.getByTestId('skill-ref-none').textContent).toMatch(/Nothing to reference yet/);
        expect(screen.queryByTestId('skill-ref-unread')).toBeNull();
    });

    it('says it is still asking before the first answer — not "nothing to reference"', () => {
        render(<Harness
            initial={[{ id: 'a', text: 'x', refs: [] }]}
            refOptions={{}}
            listStatus={{ loaded: false, unavailable: [] }}
        />);
        fireEvent.click(screen.getByTestId('skill-step-ref-add'));
        expect(screen.getByTestId('skill-ref-loading')).toBeTruthy();
        expect(screen.queryByTestId('skill-ref-none')).toBeNull();
        expect(screen.queryByText(/Nothing to reference yet/)).toBeNull();
    });

    it('names the lists it could not read, and offers to ask again', () => {
        const reload = vi.fn();
        render(<Harness
            initial={[{ id: 'a', text: 'x', refs: [] }]}
            refOptions={{}}
            listStatus={{ loaded: true, unavailable: ['automations', 'kbs', 'tables'], reload }}
        />);
        fireEvent.click(screen.getByTestId('skill-step-ref-add'));
        const note = screen.getByTestId('skill-ref-unread');
        expect(note.getAttribute('role')).toBe('status');
        expect(note.textContent).toMatch(/Could not be read/);
        expect(note.textContent).toMatch(/Automations/);
        expect(note.textContent).toMatch(/Knowledge bases/);
        expect(note.textContent).toMatch(/Tables/);
        expect(screen.queryByTestId('skill-ref-none')).toBeNull();
        fireEvent.click(screen.getByTestId('skill-ref-retry'));
        expect(reload).toHaveBeenCalledTimes(1);
    });

    /**
     * De stille variant: één lijst valt om, de andere twee komen binnen. De
     * groep Automatiseringen verdween dan geruisloos (een lege groep wordt eruit
     * gefilterd) terwijl Tables er nog stond — dat leest als "deze organisatie
     * heeft geen automations".
     */
    it('keeps the lists that DID arrive and still names the one that did not', () => {
        render(<Harness
            initial={[{ id: 'a', text: 'x', refs: [] }]}
            refOptions={{ automation: [], kb: [], table: REF_OPTIONS.table }}
            listStatus={{ loaded: true, unavailable: ['automations'] }}
        />);
        fireEvent.click(screen.getByTestId('skill-step-ref-add'));
        expect(screen.getByRole('menuitem', { name: /Pricelist/ })).toBeTruthy();
        expect(screen.getByTestId('skill-ref-unread').textContent).toMatch(/Automations/);
        expect(screen.getByTestId('skill-ref-unread').textContent).not.toMatch(/Tables/);
        expect(screen.queryByTestId('skill-ref-none')).toBeNull();
    });

    it('shows a reference by its bare id when the referenced thing is gone', () => {
        render(<Harness
            initial={[{ id: 'a', text: 'x', refs: [{ kind: 'table', id: 'deleted-table' }] }]}
        />);
        expect(screen.getByText('deleted-table')).toBeTruthy();
    });

    /**
     * The pill used to be a <button> unconditionally, and nothing ever
     * passed `onOpenRef` — so every reference in every step was a control
     * that swallowed a click and did nothing. A control that does nothing is
     * worse than no control: it teaches that the app is broken.
     */
    it('opens the referenced thing when there is somewhere to go', () => {
        const onOpenRef = vi.fn();
        render(<Harness
            initial={[{ id: 'a', text: 'x', refs: [{ kind: 'table', id: 't1' }] }]}
            onOpenRef={onOpenRef}
        />);
        fireEvent.click(screen.getByRole('button', { name: 'Pricelist' }));
        expect(onOpenRef).toHaveBeenCalledWith({ kind: 'table', id: 't1' });
    });

    it('is plain text, not a dead button, when there is nowhere to go', () => {
        render(<Harness initial={[{ id: 'a', text: 'x', refs: [{ kind: 'table', id: 't1' }] }]} />);
        expect(screen.getByText('Pricelist')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Pricelist' })).toBeNull();
    });

    it('still opens a reference for a read-only viewer — looking is not editing', () => {
        const onOpenRef = vi.fn();
        render(<Harness
            initial={[{ id: 'a', text: 'x', refs: [{ kind: 'kb', id: 'k1' }] }]}
            onOpenRef={onOpenRef}
            readOnly
        />);
        fireEvent.click(screen.getByRole('button', { name: 'Quote terms' }));
        expect(onOpenRef).toHaveBeenCalledWith({ kind: 'kb', id: 'k1' });
        expect(screen.queryByRole('button', { name: /Remove reference/i })).toBeNull();
    });

    it('gives a read-only viewer no add, no remove, no grip and no ref picker', () => {
        render(<Harness initial={[{ id: 'a', text: 'x', refs: [{ kind: 'kb', id: 'k1' }] }]} readOnly />);
        expect(screen.queryByTestId('skill-step-add')).toBeNull();
        expect(screen.queryByTestId('skill-step-grip')).toBeNull();
        expect(screen.queryByTestId('skill-step-ref-add')).toBeNull();
        expect(screen.queryByRole('button', { name: /Remove step/i })).toBeNull();
    });
});

describe('rules', () => {
    it('adds a rule that defaults to "always", not to a negation', () => {
        const onRules = vi.fn();
        render(<RulesHarness onRules={onRules} />);
        fireEvent.click(screen.getByTestId('skill-rule-add'));
        expect(onRules.mock.calls.at(-1)[0][0].polarity).toBe('must');
    });

    it('flips polarity from the mark that shows it, in both directions', () => {
        const onRules = vi.fn();
        render(<RulesHarness
            initial={[{ id: 'r1', polarity: 'must', text: 'Answer in the language of the question.' }]}
            onRules={onRules}
        />);
        fireEvent.click(screen.getByTestId('skill-rule-polarity'));
        expect(onRules.mock.calls.at(-1)[0][0].polarity).toBe('never');
        fireEvent.click(screen.getByTestId('skill-rule-polarity'));
        expect(onRules.mock.calls.at(-1)[0][0].polarity).toBe('must');
    });

    it('names the flip by what it will DO, not by what the rule currently is', () => {
        render(<RulesHarness initial={[{ id: 'r1', polarity: 'never', text: 'x' }]} />);
        expect(screen.getByTestId('skill-rule-polarity').getAttribute('aria-label'))
            .toBe('Change to “always do this”');
    });

    it('leaves a read-only viewer the state but not the control', () => {
        render(<RulesHarness initial={[{ id: 'r1', polarity: 'never', text: 'x' }]} readOnly />);
        expect(screen.getByTestId('skill-rule-polarity').getAttribute('aria-label')).toBe('Never');
        expect(screen.getByTestId('skill-rule-polarity').disabled).toBe(true);
        expect(screen.queryByTestId('skill-rule-add')).toBeNull();
    });

    it('removes the rule that was asked for, by id', () => {
        const onRules = vi.fn();
        render(<RulesHarness
            initial={[{ id: 'r1', polarity: 'must', text: 'a' }, { id: 'r2', polarity: 'never', text: 'b' }]}
            onRules={onRules}
        />);
        const rows = screen.getAllByTestId('skill-rule');
        fireEvent.click(within(rows[1]).getByRole('button', { name: /Remove rule/i }));
        expect(onRules.mock.calls.at(-1)[0].map(r => r.id)).toEqual(['r1']);
    });
});
