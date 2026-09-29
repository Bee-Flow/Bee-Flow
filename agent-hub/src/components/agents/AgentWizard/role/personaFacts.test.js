// @vitest-environment node
/**
 * personaFacts — de feiten achter de tab "Rol" (A3 deel A).
 *
 * Run: cd agent-hub && ./node_modules/.bin/vitest run src/components/agents/AgentWizard/role/personaFacts.test.js
 */
import { describe, it, expect } from 'vitest';

import {
    PERSONA_LIMITS, READ, TONE_CHIPS,
    addBullet, editBullet, handoffBlockedBecause, handoffChoices, patchPersona,
    personaShape, removeBullet, selectedHandoff, toggleToneChip, toneChipRows,
    toneChipsFull, toneLanguageClash,
} from './personaFacts';

const FIELDS = {
    who: 'An experienced colleague.',
    tone: { chips: ['formal'], text: 'Answer first.' },
    does: ['Look up quotes'],
    doesNot: ['Promise a discount'],
    unknown: { mode: 'honest', automationId: null },
    language: null,
    mode: 'fields',
    freeText: '',
};

describe('personaShape — onbekend is geen leeg', () => {
    it('meldt een ontbrekende persona als NIET gelezen', () => {
        for (const raw of [undefined, null, '', 'nope', 42, []]) {
            const { persona, readable } = personaShape(raw);
            expect(readable, JSON.stringify(raw)).toBe(false);
            expect(persona.who).toBe('');
            expect(persona.does).toEqual([]);
        }
    });

    it('meldt een lege persona als WEL gelezen', () => {
        const { persona, readable } = personaShape({});
        expect(readable).toBe(true);
        expect(persona.unknown).toEqual({ mode: 'honest', automationId: null });
        expect(persona.mode).toBe('fields');
    });

    it('leest ook een persona die als JSON-tekst binnenkomt', () => {
        const { persona, readable } = personaShape(JSON.stringify(FIELDS));
        expect(readable).toBe(true);
        expect(persona.who).toBe('An experienced colleague.');
    });

    it('versmalt een onbekende unknown.mode naar de smalste keuze', () => {
        expect(personaShape({ unknown: { mode: 'sudo' } }).persona.unknown.mode).toBe('honest');
        expect(personaShape({ unknown: { mode: 'web' } }).persona.unknown.mode).toBe('web');
    });

    it('versmalt een onbekende mode naar fields en laat freeText dan vallen', () => {
        const { persona } = personaShape({ mode: 'whatever', freeText: 'text' });
        expect(persona.mode).toBe('fields');
        expect(persona.freeText).toBe('');
    });

    it('houdt een automationId alleen vast in handoff-modus', () => {
        expect(personaShape({ unknown: { mode: 'handoff', automationId: 'a1' } }).persona.unknown.automationId).toBe('a1');
        expect(personaShape({ unknown: { mode: 'web', automationId: 'a1' } }).persona.unknown.automationId).toBe(null);
    });

    it('laat getypte spaties met rust — anders springt de cursor tijdens het tikken', () => {
        expect(personaShape({ who: 'hello ' }).persona.who).toBe('hello ');
        expect(personaShape({ tone: { text: 'first  ' } }).persona.tone.text).toBe('first  ');
    });
});

describe('patchPersona — altijd een volledige persona', () => {
    it('geeft elk veld terug, ook de niet-gepatchte', () => {
        const next = patchPersona(FIELDS, { who: 'Someone else.' });
        expect(Object.keys(next).sort()).toEqual(
            ['does', 'doesNot', 'freeText', 'language', 'mode', 'tone', 'unknown', 'who'],
        );
        expect(next.does).toEqual(['Look up quotes']);
        expect(next.who).toBe('Someone else.');
    });

    it('gooit het automationId weg zodra de modus geen handoff meer is', () => {
        const handoff = patchPersona(FIELDS, { unknown: { mode: 'handoff', automationId: 'a1' } });
        expect(handoff.unknown.automationId).toBe('a1');
        const web = patchPersona(handoff, { unknown: { mode: 'web', automationId: 'a1' } });
        expect(web.unknown.automationId).toBe(null);
    });
});

describe('toonchips', () => {
    it('biedt de vijf chips aan en zet de opgeslagene op aan', () => {
        const rows = toneChipRows({ tone: { chips: ['concise'] } });
        expect(rows.slice(0, 5).map(r => r.value)).toEqual([...TONE_CHIPS]);
        expect(rows.find(r => r.value === 'concise').on).toBe(true);
        expect(rows.find(r => r.value === 'friendly').on).toBe(false);
    });

    it('laat een chip die de kaart niet aanbiedt staan in plaats van hem te verzwijgen', () => {
        const rows = toneChipRows({ tone: { chips: ['warm'] } });
        const own = rows.filter(r => !r.offered);
        expect(own).toEqual([{ value: 'warm', on: true, offered: false }]);
    });

    it('schakelt een chip aan en uit', () => {
        const on = toggleToneChip(FIELDS, 'friendly');
        expect(on.tone.chips).toEqual(['formal', 'friendly']);
        expect(toggleToneChip(on, 'formal').tone.chips).toEqual(['friendly']);
    });

    it('voegt boven de twaalfde chip niets meer toe — de server gooit die weg', () => {
        const twelve = Array.from({ length: PERSONA_LIMITS.chips }, (_, i) => `chip${i}`);
        const persona = { tone: { chips: twelve, text: '' } };
        expect(toneChipsFull(persona)).toBe(true);
        expect(toggleToneChip(persona, 'friendly').tone.chips).toHaveLength(PERSONA_LIMITS.chips);
        // Uitzetten mag altijd, ook als het vol is.
        expect(toggleToneChip(persona, 'chip0').tone.chips).toHaveLength(PERSONA_LIMITS.chips - 1);
    });

    it('ziet de botsing tussen een harde taalregel en de zachte taalchip', () => {
        expect(toneLanguageClash({ language: 'nl', tone: { chips: ['Dutch unless asked otherwise'] } })).toBe(true);
        expect(toneLanguageClash({ language: null, tone: { chips: ['Dutch unless asked otherwise'] } })).toBe(false);
        expect(toneLanguageClash({ language: 'nl', tone: { chips: ['formal'] } })).toBe(false);
    });
});

describe('bullets — de server gooit stil weg, wij niet', () => {
    it('voegt toe', () => {
        expect(addBullet(['a'], 'b')).toEqual({ list: ['a', 'b'], rejected: null });
    });

    it('weigert een dubbele, hoofdletter-ongevoelig, net als de server', () => {
        expect(addBullet(['Look up quotes'], 'look UP quotes')).toEqual({ list: ['Look up quotes'], rejected: 'duplicate' });
    });

    it('weigert een lege regel zonder er iets van te maken', () => {
        expect(addBullet(['a'], '   ')).toEqual({ list: ['a'], rejected: 'empty' });
    });

    it('weigert de eenentwintigste', () => {
        const full = Array.from({ length: PERSONA_LIMITS.bullets }, (_, i) => `line ${i}`);
        const res = addBullet(full, 'one more');
        expect(res.rejected).toBe('full');
        expect(res.list).toHaveLength(PERSONA_LIMITS.bullets);
    });

    it('knipt een te lange regel op de grens van de server', () => {
        const { list } = addBullet([], 'x'.repeat(PERSONA_LIMITS.bullet + 50));
        expect(list[0]).toHaveLength(PERSONA_LIMITS.bullet);
    });

    it('bewerkt, en verwijdert bij leegmaken', () => {
        expect(editBullet(['a', 'b'], 1, 'c')).toEqual({ list: ['a', 'c'], rejected: null });
        expect(editBullet(['a', 'b'], 1, '  ')).toEqual({ list: ['a'], rejected: null });
        expect(editBullet(['a', 'b'], 5, 'c')).toEqual({ list: ['a', 'b'], rejected: 'missing' });
    });

    it('bewerken naar een regel die er al staat WEIGERT — het haalde er anders één weg', () => {
        // Klemmen na de vervanging ontdubbelt hoofdletter-ongevoelig en houdt de
        // eerste treffer: twee regels in, één regel uit, en de bewerkte regel
        // spoorloos. Precies de stille verdwijning waar deze kaart tegen bestaat.
        const res = editBullet(['Look up quotes', 'Check stock'], 1, 'look up QUOTES');
        expect(res.rejected).toBe('duplicate');
        expect(res.list).toEqual(['Look up quotes', 'Check stock']);
    });

    it('een regel naar zichzelf bewerken (andere hoofdletters) is geen duplicaat', () => {
        const res = editBullet(['Look up quotes', 'Check stock'], 0, 'LOOK UP QUOTES');
        expect(res.rejected).toBe(null);
        expect(res.list).toEqual(['LOOK UP QUOTES', 'Check stock']);
    });

    it('verwijdert op index', () => {
        expect(removeBullet(['a', 'b', 'c'], 1)).toEqual(['a', 'c']);
        expect(removeBullet(['a'], -1)).toEqual(['a']);
    });

    it('de getekende lijst en de gemuteerde lijst zijn DEZELFDE lijst', () => {
        // `personaShape` klemt de bullets, dus index 2 op het scherm is index 2
        // in de mutatie. Zonder dat haalde `removeBullet(['a','A','b'], 2)` de
        // regel 'A' weg die niemand had aangewezen, en bleef 'b' staan.
        const { persona } = personaShape({ ...FIELDS, does: ['a', 'A', 'b'] });
        expect(persona.does).toEqual(['a', 'b']);
        expect(removeBullet(persona.does, 1)).toEqual(['a']);
    });
});

describe('de hand-off-routine', () => {
    const CALLABLE = { id: 'a1', title: 'Pass the question on', isActive: true, definition: { trigger: { kind: 'agent_call' } } };
    const SCHEDULED = { id: 'a2', title: 'Nightly report', isActive: true, definition: { trigger: { kind: 'schedule' } } };
    const OFF = { id: 'a3', title: 'Old handover', isActive: false, triggerKind: 'agent_call' };

    it('laat alleen agent_call-routines door', () => {
        const { rows } = handoffChoices({ automations: [CALLABLE, SCHEDULED, OFF] });
        expect(rows.map(r => r.id)).toEqual(['a1', 'a3']);
    });

    it('markeert een uitgeschakelde routine in plaats van hem te verzwijgen', () => {
        const { rows } = handoffChoices({ automations: [CALLABLE, OFF] });
        expect(rows.find(r => r.id === 'a3').active).toBe(false);
        expect(rows.find(r => r.id === 'a1').active).toBe(true);
    });

    it('geeft bij een mislukte lezing geen lege lijst maar de fouttoestand door', () => {
        const failed = handoffChoices({ automations: null, state: READ.ERROR });
        expect(failed.state).toBe(READ.ERROR);
        expect(failed.rows).toEqual([]);
        expect(handoffChoices({ automations: [CALLABLE], state: READ.LOADING }).state).toBe(READ.LOADING);
    });

    it('OK met iets dat GEEN lijst is, is onleesbaar — niet "geen routines"', () => {
        // Dit is precies de invoer die de standaardwaarden van de kaarten
        // opleveren (`automations = null, automationsState = READ.OK`), en
        // `selectedHandoff` hieronder én `toolGrants.automationRows` lazen hem
        // al als onleesbaar. Zonder deze versmalling zette één kaart twee
        // tegenstrijdige zinnen onder elkaar: "geen enkele routine kan door een
        // agent gestart worden" én "deze routine kon hier niet gelezen worden".
        for (const junk of [null, undefined, 'nope', { 0: CALLABLE }]) {
            expect(handoffChoices({ automations: junk, state: READ.OK }))
                .toEqual({ rows: [], state: READ.ERROR });
        }
        expect(handoffChoices({ automations: [], state: READ.OK }))
            .toEqual({ rows: [], state: READ.OK });
    });

    it('toetst het eigenaarschap zoals de server dat doet, en versmalt bij twijfel', () => {
        expect(handoffBlockedBecause({ agentOwnerId: 'u1', userId: 'u1' })).toBe(null);
        expect(handoffBlockedBecause({ agentOwnerId: 'u2', userId: 'u1' })).toBe('not_owner');
        expect(handoffBlockedBecause({ agentOwnerId: null, userId: 'u1' })).toBe('unknown_owner');
        expect(handoffBlockedBecause({ agentOwnerId: 'u1', userId: null })).toBe('unknown_owner');
        expect(handoffBlockedBecause({})).toBe('unknown_owner');
    });

    it('houdt een gekozen routine zichtbaar als de lijst niet gelezen kon worden', () => {
        const chosen = selectedHandoff({ automations: null, state: READ.ERROR, automationId: 'a1' });
        expect(chosen).toEqual({ id: 'a1', title: null, readable: false, active: null, callable: null });
    });

    it('meldt een gekozen routine die de lijst niet kent als onleesbaar, niet als afwezig', () => {
        const chosen = selectedHandoff({ automations: [SCHEDULED], automationId: 'a1' });
        expect(chosen.readable).toBe(false);
        expect(chosen.id).toBe('a1');
    });

    it('geeft naam, aan/uit en aanroepbaarheid van de gekozen routine', () => {
        expect(selectedHandoff({ automations: [CALLABLE], automationId: 'a1' }))
            .toEqual({ id: 'a1', title: 'Pass the question on', readable: true, active: true, callable: true });
        expect(selectedHandoff({ automations: [SCHEDULED], automationId: 'a2' }).callable).toBe(false);
    });

    it('geeft null als er niets gekozen is', () => {
        expect(selectedHandoff({ automations: [CALLABLE], automationId: null })).toBe(null);
    });
});
