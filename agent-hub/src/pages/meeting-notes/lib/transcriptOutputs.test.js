// @vitest-environment node
/**
 * Wat er uit dit transcript kwam (plan M4 stap 2, artboard 1b).
 *
 * TWEE DINGEN ZIJN HIER DRAGEND, de rest is vorm:
 *
 *  1. ONBEKEND IS GEEN NUL. Een kb-scan die niet kon draaien mag nooit lezen
 *     als "er staat niets van deze vergadering in een kennisbank" — dat is
 *     dezelfde fail-open die de verwijderbevestiging en de outputs-balk
 *     overal vermijden, één scherm verderop.
 *  2. DE GATE HEEFT GEEN ACHTERDEUR. Met per-persoonsstatistiek uit mag de
 *     vraag over een niet-herkende spreker geen NAAM noemen. De aantallen
 *     mogen blijven; de toeschrijving niet.
 *
 * Draaien: cd agent-hub && npx vitest run src/pages/meeting-notes/lib/transcriptOutputs.test.js
 */
import { describe, expect, it } from 'vitest';

import {
    KNOWLEDGE_LINES,
    SPEAKER_CHECK,
    buildKnowledgeLines,
    buildSpeakerCheck,
} from './transcriptOutputs';

/** Een usage-rij zoals meetingUsage.js hem levert voor gefileerde regels. */
const filed = (id, lineCount, over = {}) => ({
    kind: 'kb', id, title: id.toUpperCase(), role: 'contains', lineCount, ownerId: 'me', ...over,
});
/** Een kb die deze vergadering via een TAG verzamelt — een andere bewering. */
const byTag = (id) => ({ kind: 'kb', id, title: id, role: 'contains', siteLabel: 'sales', ownerId: 'me' });

/** Het stukje insights-model dat buildSpeakerCheck leest. */
const model = (...ids) => ({ talk: { speakers: ids.map((speakerId) => ({ speakerId })) } });

describe('buildKnowledgeLines', () => {
    it('has not answered while the usage fetch is still running', () => {
        expect(buildKnowledgeLines(null).state).toBe(KNOWLEDGE_LINES.LOADING);
        expect(buildKnowledgeLines(undefined).state).toBe(KNOWLEDGE_LINES.LOADING);
    });

    it('an empty list is an ANSWER, not a gap', () => {
        const out = buildKnowledgeLines([]);
        expect(out.state).toBe(KNOWLEDGE_LINES.READY);
        expect(out.partial).toBe(false);
        expect(out.rows).toEqual([]);
        expect(out.total).toBe(0);
    });

    it('keeps only knowledge bases that actually hold filed lines', () => {
        const out = buildKnowledgeLines([
            filed('kb-1', 2),
            // A base that collects the tag holds no line anybody filed.
            byTag('kb-9'),
            { kind: 'automation', id: 'a-1', lineCount: 4 },
            filed('kb-2', 0),
            filed('kb-3', '3'),
            null,
        ]);
        expect(out.rows.map((r) => r.id)).toEqual(['kb-1']);
        expect(out.total).toBe(2);
    });

    it('sums the count across knowledge bases without recounting anything', () => {
        const out = buildKnowledgeLines([filed('kb-1', 2), filed('kb-2', 5)]);
        expect(out.total).toBe(7);
        // The rows come back untouched, so the renderer can use usageHref /
        // isForeignRow on the real row rather than a copy that lost `ownerId`.
        expect(out.rows[1]).toEqual(filed('kb-2', 5));
    });

    it('a scan that could not run and found nothing is UNKNOWN, never zero', () => {
        const byError = buildKnowledgeLines([], { error: new Error('500') });
        expect(byError.state).toBe(KNOWLEDGE_LINES.UNKNOWN);
        expect(byError.partial).toBe(true);

        const byUnchecked = buildKnowledgeLines([], { unchecked: ['kb'] });
        expect(byUnchecked.state).toBe(KNOWLEDGE_LINES.UNKNOWN);
    });

    it('a scan that could not run but found something says "at least this"', () => {
        const out = buildKnowledgeLines([filed('kb-1', 2)], { unchecked: ['kb'] });
        expect(out.state).toBe(KNOWLEDGE_LINES.READY);
        expect(out.partial).toBe(true);
        expect(out.total).toBe(2);
    });

    it('another kind going unchecked says nothing about knowledge bases', () => {
        const out = buildKnowledgeLines([], { unchecked: ['notebook', 'automation'] });
        expect(out.state).toBe(KNOWLEDGE_LINES.READY);
        expect(out.partial).toBe(false);
    });
});

describe('buildSpeakerCheck', () => {
    const meeting = { attendees: ['Tom', 'Sandra', 'Marijke'] };

    it('asks nothing when the diarisation could not be read', () => {
        // buildInsightsModel answers null for a note with no duration or no
        // segments. "Fewer speakers than attendees" is then not a shortage but
        // a hole in what we know — and naming somebody out of a hole is worse
        // than saying nothing.
        const out = buildSpeakerCheck(meeting, null);
        expect(out.state).toBe(SPEAKER_CHECK.UNKNOWN);
        expect(out.speakerCount).toBe(null);
        expect(out.attendeeCount).toBe(3);
        expect(out.names).toBe(null);
    });

    it('asks nothing when there is no readable attendee list', () => {
        const out = buildSpeakerCheck({ attendees: 'Tom, Sandra' }, model('Tom'));
        expect(out.state).toBe(SPEAKER_CHECK.UNKNOWN);
        expect(out.attendeeCount).toBe(null);
        expect(buildSpeakerCheck({}, model('Tom')).state).toBe(SPEAKER_CHECK.UNKNOWN);
    });

    it('an empty attendee list is COMPLETE — there is nothing to compare with', () => {
        const out = buildSpeakerCheck({ attendees: [] }, model('Tom'));
        expect(out.state).toBe(SPEAKER_CHECK.COMPLETE);
        // Empty and unreadable stay distinguishable: 0 is a count, null is not.
        expect(out.attendeeCount).toBe(0);
    });

    it('says nothing when everybody was recognised', () => {
        const out = buildSpeakerCheck(meeting, model('Tom', 'Sandra', 'Marijke'));
        expect(out.state).toBe(SPEAKER_CHECK.COMPLETE);
        expect(out.names).toBe(null);
    });

    it('names the attendee nobody was matched to when the gate is open', () => {
        const out = buildSpeakerCheck(meeting, model('Tom', 'Sandra'));
        expect(out.state).toBe(SPEAKER_CHECK.GAP);
        expect(out.speakerCount).toBe(2);
        expect(out.attendeeCount).toBe(3);
        expect(out.names).toEqual(['Marijke']);
    });

    it('NAMES NOBODY when the org disabled per-person statistics', () => {
        const out = buildSpeakerCheck(meeting, model('Tom', 'Sandra'), { perPersonEnabled: false });
        expect(out.state).toBe(SPEAKER_CHECK.GAP);
        // The counts are meeting-level and stay; the attribution does not.
        expect(out.speakerCount).toBe(2);
        expect(out.attendeeCount).toBe(3);
        expect(out.names).toBe(null);
    });

    it('blank and non-string attendees never become a name to ask about', () => {
        const out = buildSpeakerCheck(
            { attendees: ['Tom', '  ', null, 7, 'Marijke'] },
            model('Tom'),
        );
        expect(out.attendeeCount).toBe(2);
        expect(out.names).toEqual(['Marijke']);
    });

    it('a gap with no matchable name still reports the gap, with no name', () => {
        // Two attendees, two guest labels the matcher cannot tie to either —
        // "Guest-1" matches nobody, so both attendees look unrecognised while
        // the count says only one is missing. The state is the count's; the
        // sentence falls back to the count because there is no single name.
        const out = buildSpeakerCheck({ attendees: ['Tom', 'Sandra', 'Marijke'] }, model('Guest-1', 'Guest-2'));
        expect(out.state).toBe(SPEAKER_CHECK.GAP);
        expect(out.names).toEqual(['Tom', 'Sandra', 'Marijke']);
    });
});
