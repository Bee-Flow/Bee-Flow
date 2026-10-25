// @vitest-environment node
/**
 * The card footer of an agent (A5, part D) — the RULES, without rendering.
 *
 * Four properties that this file pins, each with its own bug behind it:
 *
 *   1. The "answers from memory" warning comes from the SERVER and is not recalculated here. `grounding.verdict` is the only word that counts; three axes that happen to all be `false` without a verdict are NO warning, because then this file would implement the rule a second time — and that is exactly how the overview and the start screen drift apart over the same agent.
 *   2. A count that could not be read is `null`, never 0. `stats: null` (the server could not read it), a row without `stats`, and a `conversationCount` that is not a number all come back as `null` — a 0 would be a claim that nobody has made.
 *   3. "Only you" is a claim about SCOPE and needs EVIDENCE: not published, your agent, and `othersConversationCount === 0` — counted, not assumed. `userCount` does not carry that claim: it is COUNT(DISTINCT user_id) over ALL conversations, so one counts just as much as a colleague who held forty while you held none.
 *   4. The warning applies only where Studio's start screen would also give it — a PUBLISHED agent — and only where the draft is also what runs. Otherwise the overview shouts about agents that the start screen deliberately stays silent about, or makes a statement about a version that is not running.
 *
 * Run: cd agent-hub && ./node_modules/.bin/vitest run src/components/agents/AgentStudio/cardFooter.test.js
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
        // routes/studio/attentionChecks.js filters on `is_published = TRUE`, on the grounds that a draft without a knowledge base is an agent that is being built. Without this boundary every newly created card got a warning, and that also displaced the counts.
        expect(summariseCardFooter(agent({ grounding: ungrounded, is_published: false }), 'u1').variant)
            .toBe('counts');
        const { is_published: _p, ...rest } = agent({ grounding: ungrounded });
        expect(summariseCardFooter(rest, 'u1').variant).toBe('counts');
    });

    it('stays silent when the row runs a PUBLISHED version this list cannot see', () => {
        // `grounding` is calculated over the DRAFT config; for a row with published_version > 0 the runtime serves `published_config`, and that blob never leaves the store. Directly under a pill that says "LIVE v8", making a statement about a version that is not running is a contradiction on one card.
        expect(summariseCardFooter(agent({ grounding: ungrounded, published_version: 8 }), 'u1').variant)
            .toBe('counts');
    });

    it('does NOT re-derive the rule from the axes', () => {
        // All three axes empty, but the server has not delivered a judgement. Concluding it ourselves would be the second implementation that this file specifically avoids.
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
        // A PUBLISHED agent that you own: the warning is the only one of the three that asks for something, so it wins. (On a draft the warning does not come at all — see above.)
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
        // /agents/system does not calculate counts and does not carry the field: there is nothing to say about it there. `stats: null` is a route that DID try and failed, and that deserves words.
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
        // The case that occurs in practice: you publish, a colleague conducts forty conversations with it, you never do, and afterwards you set it back to draft. `setAgentPublished` does a single UPDATE — the rows stay. On `userCount === 1` alone the card would say "Only you · 40 conversations", and both halves are untrue.
        const f = summariseCardFooter(priv({
            stats: { conversationCount: 40, userCount: 1, othersConversationCount: 40 },
        }), 'u1');
        expect(f.variant).toBe('counts');
    });

    it('does NOT show when the server could not say whose the conversations are', () => {
        // Without excludeUserId the FILTER counts every row; the route then sends `null`, and a 0 there would pretend to have evidence that does not exist.
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
        // Without tallies there is no evidence, and "Only you" is a claim.
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
