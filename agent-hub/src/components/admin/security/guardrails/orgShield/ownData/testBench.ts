import type {
    Sentence, SentenceOrigin, Span, Summary, TypeTests,
} from './ownDataModel';
import { LIMITS } from './ownDataModel';

/**
 * The test bench's pure half: sentences, their gold marks ("this should be
 * hidden") and the scoring of a test run against them.
 *
 * Wire shape is `{ start, end }` in UTF-16 offsets, which is what both
 * `String.prototype.slice` and the server's JavaScript matcher use, so an
 * offset never needs translating on either side.
 *
 * Scoring mirrors the server's rule (core/privacy/customData/scoring.js):
 * a gold span counts as found when at least half of its characters are
 * covered by what the matcher found. Keeping the rule here as well lets a
 * right/wrong choice update the read-out at once, without another test run.
 */

export type MarkKind = 'hit' | 'missed' | 'false_alarm' | 'found';
export interface Mark extends Span { kind: MarkKind; partial?: boolean }

/** What one test run left behind: the found spans per sentence. */
export interface RunFindings {
    found: Record<string, Span[]>;
    fingerprint: string;
    engine: 'local' | 'guard';
    degraded?: boolean;
}

export function newSentenceId(): string {
    const bytes = new Uint8Array(4);
    globalThis.crypto.getRandomValues(bytes);
    return `s_${Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')}`;
}

/** A new sentence. Leave `gold` out for "not marked yet"; `[]` means "nothing should be hidden". */
export function makeSentence(text: string, origin: SentenceOrigin = 'own', gold?: Span[]): Sentence {
    const clean = String(text || '').slice(0, LIMITS.sentence);
    const s: Sentence = { id: newSentenceId(), text: clean, origin };
    if (gold) s.gold = normaliseSpans(gold, clean.length);
    return s;
}

/** Has anyone said what should be hidden in this sentence (even "nothing")? */
export function isMarked(sentence: Sentence): boolean {
    return Array.isArray(sentence.gold);
}

export function emptyTests(): TypeTests {
    return { examples: [], sentences: [] };
}

/** Sorted, clamped to the text, merged where they touch or overlap, no empties. */
export function normaliseSpans(spans: readonly Span[], textLength: number): Span[] {
    const clamped = spans
        .map(s => ({ start: Math.max(0, Math.min(s.start, textLength)), end: Math.max(0, Math.min(s.end, textLength)) }))
        .filter(s => s.end > s.start)
        .sort((a, b) => a.start - b.start || a.end - b.end);
    const out: Span[] = [];
    for (const s of clamped) {
        const last = out[out.length - 1];
        if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
        else out.push({ ...s });
    }
    return out;
}

const overlaps = (a: Span, b: Span): boolean => a.start < b.end && b.start < a.end;

/**
 * Mark one span as "should be hidden". Refuses (returns `capped`) rather
 * than silently dropping a mark once a sentence carries the maximum of five.
 */
export function addGold(sentence: Sentence, span: Span): { sentence: Sentence; capped: boolean } {
    const gold = normaliseSpans([...(sentence.gold || []), span], sentence.text.length);
    if (gold.length > LIMITS.gold) return { sentence, capped: true };
    return { sentence: { ...sentence, gold }, capped: false };
}

/**
 * "It should not be hidden": drop every gold span the given span touches.
 * On an unmarked sentence this is a decision too, so it leaves `gold: []`.
 */
export function removeGold(sentence: Sentence, span: Span): Sentence {
    return { ...sentence, gold: (sentence.gold || []).filter(g => !overlaps(g, span)) };
}

/** Every non-overlapping occurrence of `needle`, case-insensitive by default. */
export function findAll(text: string, needle: string, caseSensitive = false): Span[] {
    const n = String(needle || '');
    if (!n) return [];
    const hay = caseSensitive ? text : text.toLowerCase();
    const want = caseSensitive ? n : n.toLowerCase();
    const out: Span[] = [];
    let from = 0;
    for (;;) {
        const at = hay.indexOf(want, from);
        if (at === -1) break;
        out.push({ start: at, end: at + want.length });
        from = at + want.length;
    }
    return out;
}

/**
 * The keyboard and touch path: type the exact text, and every occurrence of
 * it in the sentence is marked. `count` 0 means the text is not in the
 * sentence, which the caller reports instead of doing nothing.
 */
export function markAllOccurrences(sentence: Sentence, needle: string): { sentence: Sentence; count: number; capped: boolean } {
    const hits = findAll(sentence.text, needle.trim());
    if (hits.length === 0) return { sentence, count: 0, capped: false };
    const gold = normaliseSpans([...(sentence.gold || []), ...hits], sentence.text.length);
    if (gold.length > LIMITS.gold) return { sentence, count: hits.length, capped: true };
    return { sentence: { ...sentence, gold }, count: hits.length, capped: false };
}

/**
 * The request body's sentence list. `gold` is sent only when the sentence is
 * marked: the server reads an absent `gold` as "not marked" and `[]` as
 * "nothing should be hidden", and the two must never be conflated.
 */
export function wireSentences(sentences: readonly Sentence[]): Sentence[] {
    return sentences.slice(0, LIMITS.sentences).map(s => ({
        id: s.id,
        text: s.text,
        ...(s.gold ? { gold: s.gold.map(g => ({ start: g.start, end: g.end })) } : {}),
        origin: s.origin,
    }));
}

/** The spans the matcher actually found, out of a server result's marks. */
export function foundSpansOf(marks: readonly Mark[]): Span[] {
    return marks
        .filter(m => m.kind === 'hit' || m.kind === 'false_alarm' || m.kind === 'found')
        .map(m => ({ start: m.start, end: m.end }));
}

function coveredChars(g: Span, found: readonly Span[]): number {
    let n = 0;
    for (const f of found) n += Math.max(0, Math.min(g.end, f.end) - Math.max(g.start, f.start));
    return n;
}

/**
 * Marks for one sentence, from its gold and what was found. Always disjoint,
 * so they can be rendered as runs: hits and misses take the gold span's
 * extent, and a false alarm is a find that touches no gold span at all.
 *
 * On an unmarked sentence (no `gold`) nothing can be right or wrong yet, so
 * a find is simply a find ('found'), not a false alarm.
 */
export function scoreSentence(sentence: Sentence, foundRaw: readonly Span[]): Mark[] {
    const found = normaliseSpans(foundRaw, sentence.text.length);
    const gold = sentence.gold || [];
    const marks: Mark[] = [];
    for (const g of gold) {
        const covered = coveredChars(g, found);
        const len = g.end - g.start;
        if (covered * 2 >= len) marks.push({ ...g, kind: 'hit', ...(covered < len ? { partial: true } : {}) });
        else marks.push({ ...g, kind: 'missed', ...(covered > 0 ? { partial: true } : {}) });
    }
    const kind: MarkKind = isMarked(sentence) ? 'false_alarm' : 'found';
    for (const f of found) {
        if (!gold.some(g => overlaps(g, f))) marks.push({ ...f, kind });
    }
    return marks.sort((a, b) => a.start - b.start);
}

export type SentenceVerdict = 'correct' | 'missed' | 'false_alarm' | 'mixed';

export function sentenceVerdict(marks: readonly Mark[]): { verdict: SentenceVerdict; missed: number; falseAlarms: number } {
    const missed = marks.filter(m => m.kind === 'missed').length;
    const falseAlarms = marks.filter(m => m.kind === 'false_alarm').length;
    let verdict: SentenceVerdict = 'correct';
    if (missed && falseAlarms) verdict = 'mixed';
    else if (missed) verdict = 'missed';
    else if (falseAlarms) verdict = 'false_alarm';
    return { verdict, missed, falseAlarms };
}

/**
 * The read-out's numbers, over the MARKED sentences the last run scored.
 * An unmarked sentence says nothing about right or wrong, so it is left out.
 */
export function summarise(sentences: readonly Sentence[], run: RunFindings | null): Summary {
    const tested = run
        ? sentences.filter(s => isMarked(s) && Object.prototype.hasOwnProperty.call(run.found, s.id))
        : [];
    let found = 0;
    let total = 0;
    let falseAlarms = 0;
    for (const s of tested) {
        const marks = scoreSentence(s, run!.found[s.id]);
        total += (s.gold || []).length;
        found += marks.filter(m => m.kind === 'hit').length;
        falseAlarms += marks.filter(m => m.kind === 'false_alarm').length;
    }
    return { found, total, falseAlarms, sentences: tested.length };
}

/** How many sentences carry at least one gold mark (Tune needs five). */
export function goldSentenceCount(sentences: readonly Sentence[]): number {
    return sentences.filter(s => (s.gold || []).length > 0).length;
}

export interface RunSpan { offset: number; length: number; kind: MarkKind | 'gold'; start: number; end: number; partial?: boolean }

/** Marks in the `{ offset, length }` shape `buildRuns` (dlpFindingsState) expects. */
export function toRunSpans(marks: readonly (Mark | (Span & { kind: 'gold' }))[]): RunSpan[] {
    return marks.map(m => ({
        offset: m.start,
        length: m.end - m.start,
        kind: m.kind,
        start: m.start,
        end: m.end,
        ...('partial' in m && m.partial ? { partial: true } : {}),
    }));
}
