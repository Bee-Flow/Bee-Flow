// @vitest-environment node
/**
 * De kaartvoet van een agent (A5, deel D) — de REGELS, zonder rendering.
 *
 * Drie eigenschappen die dit bestand vastpint, elk met zijn eigen bug erachter:
 *
 *   1. De waarschuwing "antwoordt uit het hoofd" komt van de SERVER en wordt
 *      hier niet nagerekend. `grounding.verdict` is het enige woord dat telt;
 *      drie assen die toevallig alle drie `false` staan zonder verdict zijn
 *      GEEN waarschuwing, want dan zou dit bestand de regel een tweede keer
 *      implementeren — en dat is precies hoe het overzicht en het Start-scherm
 *      uit elkaar gaan lopen over dezelfde agent.
 *   2. Een telling die niet gelezen kon worden is `null`, nooit 0. `stats:
 *      null` (de server kon het niet lezen), een rij zonder `stats`, en een
 *      `conversationCount` die geen getal is komen alle drie als `null` terug
 *      — een 0 zou een bewering zijn die niemand heeft gedaan.
 *   3. "Alleen jij" is een bewering over BEREIK en heeft BEWIJS nodig: niet
 *      gepubliceerd, jouw agent, en `othersConversationCount === 0` — geteld,
 *      niet aangenomen. `userCount` draagt die bewering niet: dat is
 *      COUNT(DISTINCT user_id) over álle gesprekken, dus één telt net zo goed
 *      als een collega die er veertig voerde terwijl jij er nul voerde.
 *   4. De waarschuwing geldt alleen waar Studio's Start-scherm hem ook zou
 *      geven — een GEPUBLICEERDE agent — en alleen waar het concept ook is wat
 *      draait. Anders schreeuwt het overzicht over agents waar Start bewust
 *      over zwijgt, of doet het een uitspraak over een versie die niet loopt.
 *
 * Draaien: cd agent-hub && ./node_modules/.bin/vitest run src/components/agents/AgentStudio/cardFooter.test.js
 */
import { describe, it, expect } from 'vitest';
import { summariseCardFooter, groundingVerdictOf } from './cardFooter';

const agent = (over = {}) => ({
    id: 'a1',
    owner_id: 'u1',
    is_published: true,
    published_version: 0,
    stats: {
        conversationCount: 312, userCount: 7, othersConversationCount: 305,
        lastUsedAt: '2026-09-05T10:00:00.000Z',
    },
    grounding: { kb: true, tables: false, verdict: 'grounded' },
    ...over,
});

// ── 1. De waarschuwing komt van de server ───────────────────────────────────

describe('the "answers from memory" warning', () => {
    const ungrounded = { kb: false, tables: false, verdict: 'ungrounded' };

    it('shows when the SERVER says ungrounded', () => {
        const f = summariseCardFooter(agent({ grounding: ungrounded }), 'u1');
        expect(f.variant).toBe('ungrounded');
    });

    it('stays silent on a DRAFT — the same cut Studio Home makes', () => {
        // routes/studio/attentionChecks.js filtert op `is_published = TRUE`,
        // met als reden dat een concept zonder kennisbank een agent is die
        // gebouwd wordt. Zonder deze grens kreeg elke net aangemaakte kaart een
        // waarschuwing, en verdrong die ook nog de tellingen.
        expect(summariseCardFooter(agent({ grounding: ungrounded, is_published: false }), 'u1').variant)
            .toBe('counts');
        const { is_published: _p, ...rest } = agent({ grounding: ungrounded });
        expect(summariseCardFooter(rest, 'u1').variant).toBe('counts');
    });

    it('stays silent when the row runs a PUBLISHED version this list cannot see', () => {
        // `grounding` is berekend over de CONCEPT-config; voor een rij met
        // published_version > 0 serveert de runtime `published_config`, en die
        // blob verlaat de store nooit. Pal onder een pil die "LIVE v8" zegt een
        // uitspraak doen over een versie die niet draait is een tegenspraak op
        // één kaart.
        expect(summariseCardFooter(agent({ grounding: ungrounded, published_version: 8 }), 'u1').variant)
            .toBe('counts');
    });

    it('does NOT re-derive the rule from the axes', () => {
        // Alle drie de assen leeg, maar de server heeft geen oordeel geveld.
        // Zelf concluderen zou de tweede implementatie zijn die dit bestand
        // juist vermijdt.
        const f = summariseCardFooter(agent({
            grounding: { kb: false, tables: false, verdict: null },
        }), 'u1');
        expect(f.variant).toBe('counts');
    });

    it('stays silent when the verdict could not be established', () => {
        // Een onleesbare as levert server-side `verdict: null` op. Dat is een
        // derde waarde naast gegrond en ongegrond, en er hoort zwijgen bij.
        expect(summariseCardFooter(agent({
            grounding: { kb: null, tables: false, verdict: null },
        }), 'u1').variant).toBe('counts');
    });

    it('stays silent when the row carries no grounding at all', () => {
        const { grounding: _grounding, ...rest } = agent();
        expect(summariseCardFooter(rest, 'u1').variant).toBe('counts');
        expect(groundingVerdictOf(rest)).toBeNull();
    });

    it('ignores a verdict word it does not know', () => {
        expect(groundingVerdictOf(agent({ grounding: { verdict: 'probably' } }))).toBeNull();
        expect(groundingVerdictOf(agent({ grounding: 'ungrounded' }))).toBeNull();
    });

    it('beats "only you" where both could apply', () => {
        // Een GEPUBLICEERDE agent die je zelf bezit: de waarschuwing is de enige
        // van de drie die om iets vraagt, dus die wint. (Op een concept komt de
        // waarschuwing helemaal niet — zie hierboven.)
        const f = summariseCardFooter(agent({
            stats: { conversationCount: 4, userCount: 1, othersConversationCount: 0 },
            grounding: ungrounded,
        }), 'u1');
        expect(f.variant).toBe('ungrounded');
    });
});

// ── 2. Onleesbaar is geen nul ───────────────────────────────────────────────

describe('a count nobody could read', () => {
    it('is null when the server said stats: null', () => {
        const f = summariseCardFooter(agent({ stats: null }), 'u1');
        expect(f.conversations).toBeNull();
        expect(f.people).toBeNull();
        expect(f.conversations).not.toBe(0);
    });

    it('is null when the row carries no stats at all', () => {
        const { stats: _stats, ...rest } = agent();
        expect(summariseCardFooter(rest, 'u1').conversations).toBeNull();
    });

    it('is null when the number is not a number', () => {
        expect(summariseCardFooter(agent({ stats: { conversationCount: 'lots' } }), 'u1').conversations).toBeNull();
        expect(summariseCardFooter(agent({ stats: { conversationCount: -1 } }), 'u1').conversations).toBeNull();
    });

    it('is 0 when the server actually counted zero — that IS a fact', () => {
        const f = summariseCardFooter(agent({ stats: { conversationCount: 0, userCount: 0 } }), 'u1');
        expect(f.conversations).toBe(0);
    });

    it('reads a per-field null as UNREADABLE, never as zero', () => {
        // `Number(null) === 0`, en 0 is eindig en ≥ 0 — zonder de zeef vooraf
        // leest een LEFT JOIN die wegvalt als de bewering "0 gesprekken".
        for (const value of [null, '', false, []]) {
            expect(summariseCardFooter(agent({ stats: { conversationCount: value } }), 'u1').conversations)
                .toBeNull();
        }
    });

    it('niet-gevraagd en niet-gelezen zijn twee dingen', () => {
        // /agents/system rekent geen tellingen uit en draagt het veld niet: daar
        // valt niets over te zeggen. `stats: null` is een route die het WEL
        // probeerde en faalde, en dat verdient woorden.
        const { stats: _stats, ...rest } = agent();
        expect(summariseCardFooter(rest, 'u1').statsAsked).toBe(false);
        expect(summariseCardFooter(agent({ stats: null }), 'u1').statsAsked).toBe(true);
    });
});

// ── 3. Gebruikt door: afwezig, leeg en ongecontroleerd zijn drie dingen ──────

describe('the used-by half', () => {
    it('says nothing when ?usage=1 was not asked (the field is ABSENT)', () => {
        const f = summariseCardFooter(agent(), 'u1');
        expect(f.usageAsked).toBe(false);
        expect(f.usedBy).toEqual([]);
        expect(f.unchecked).toEqual([]);
    });

    it('lists the kinds that were found, in reading order', () => {
        const f = summariseCardFooter(agent({
            usage: { counts: { app: 1, automation: 2 }, partial: [] },
        }), 'u1');
        expect(f.usageAsked).toBe(true);
        expect(f.usedBy).toEqual([{ kind: 'automation', count: 2 }, { kind: 'app', count: 1 }]);
    });

    it('drops a kind counted at zero but keeps a kind nobody could check', () => {
        const f = summariseCardFooter(agent({
            usage: { counts: { app: 0, automation: 2 }, partial: ['webpage', 'app'] },
        }), 'u1');
        expect(f.usedBy).toEqual([{ kind: 'automation', count: 2 }]);
        expect(f.unchecked).toEqual(['app', 'webpage']);
    });

    it('reads a partial that is not a list as "none of it was checked"', () => {
        const f = summariseCardFooter(agent({ usage: { counts: {}, partial: 'boom' } }), 'u1');
        expect(f.unchecked).toEqual(['task', 'cowork', 'support', 'automation', 'app', 'webpage']);
    });

    it('reports an unknown kind under its own name rather than dropping it', () => {
        const f = summariseCardFooter(agent({ usage: { counts: { hologram: 3 }, partial: [] } }), 'u1');
        expect(f.usedBy).toEqual([{ kind: 'hologram', count: 3 }]);
    });
});

// ── 4. "Alleen jij" heeft bewijs nodig ──────────────────────────────────────

describe('"only you"', () => {
    const priv = (over = {}) => agent({
        is_published: false,
        stats: { conversationCount: 4, userCount: 1, othersConversationCount: 0 },
        ...over,
    });

    it('shows on your own unpublished agent that nobody else has been in', () => {
        const f = summariseCardFooter(priv(), 'u1');
        expect(f.variant).toBe('private');
        expect(f.conversations).toBe(4);
    });

    it('does NOT show when the conversations are somebody else\'s', () => {
        // Het geval dat gewoon voorkomt: jij publiceert, een collega voert er
        // veertig gesprekken mee, jij zelf nooit, daarna zet je hem op concept.
        // `setAgentPublished` doet één UPDATE — de rijen blijven staan. Op
        // `userCount === 1` alleen zou de kaart "Alleen jij · 40 gesprekken"
        // zeggen, en beide helften zijn onwaar.
        const f = summariseCardFooter(priv({
            stats: { conversationCount: 40, userCount: 1, othersConversationCount: 40 },
        }), 'u1');
        expect(f.variant).toBe('counts');
    });

    it('does NOT show when the server could not say whose the conversations are', () => {
        // Zonder excludeUserId telt de FILTER elke rij mee; de route stuurt dan
        // `null`, en een 0 zou daar bewijs voorwenden dat er niet is.
        const f = summariseCardFooter(priv({
            stats: { conversationCount: 4, userCount: 1, othersConversationCount: null },
        }), 'u1');
        expect(f.variant).toBe('counts');
    });

    it('does not show on somebody else\'s agent', () => {
        expect(summariseCardFooter(priv(), 'u2').variant).toBe('counts');
    });

    it('does not show without a viewer', () => {
        expect(summariseCardFooter(priv()).variant).toBe('counts');
    });

    it('does not show once a published agent is reachable by everyone', () => {
        expect(summariseCardFooter(priv({ is_published: true }), 'u1').variant).toBe('counts');
    });

    it('does not show when is_published is missing — unknown narrows', () => {
        const { is_published: _isPublished, ...rest } = priv();
        expect(summariseCardFooter(rest, 'u1').variant).toBe('counts');
    });

    it('does not show when the counts saw a second person', () => {
        expect(summariseCardFooter(priv({
            stats: { conversationCount: 9, userCount: 2, othersConversationCount: 5 },
        }), 'u1').variant).toBe('counts');
    });

    it('does not show when the counts could not be read at all', () => {
        // Zonder tellingen is er geen bewijs, en "Alleen jij" is een bewering.
        expect(summariseCardFooter(priv({ stats: null }), 'u1').variant).toBe('counts');
    });
});

// ── 5. Rommel in, geen bewering uit ─────────────────────────────────────────

describe('a row that is not a row', () => {
    it('claims nothing at all', () => {
        for (const junk of [null, undefined, 'agent', 42, []]) {
            const f = summariseCardFooter(junk, 'u1');
            expect(f.variant).toBe('counts');
            expect(f.conversations).toBeNull();
            expect(f.usageAsked).toBe(false);
        }
    });
});
