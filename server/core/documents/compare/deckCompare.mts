/**
 * What changed between two presentations, slide by slide.
 *
 * Input: two NORMALISED decks (core/documents/deckModel normalizeDeck, which
 * the loader gets through deckDocument.deckFromDocument) and each document's
 * look (`settings.deck`, already through normaliseDeckOverrides).
 *
 *   1. Each slide becomes { title, layout, lines }: its readable content in
 *      reading order (body, bullets, table rows, chart series, stats, quote,
 *      columns, cards, steps, image alt text, speaker notes). The cover is
 *      slide 0 (title + subtitle), which is also the deck viewer's frame 0,
 *      so a slide's index here is the frame the UI scrolls to.
 *   2. Slides are aligned on their normalised title (LCS), and inside each
 *      gap the ones whose text is still alike are paired in order; the rest
 *      are added or removed. A matched or paired slide is `equal` or
 *      `changed` by its line diff, with the word diff inside changed lines.
 *   3. The look is compared key by key (preset, colours, fonts, cover and
 *      table style, logo, footer, template deck): a deck converted to another
 *      template usually changes here and nowhere else, and says so.
 *
 * Pure: no I/O. The template deck and the logo are compared by presence and
 * fingerprint, never sent back (they are pictures, kilobytes to megabytes).
 */

import { createHash } from 'node:crypto';
import { alignSequences } from './align.mts';
import { bagSimilarity, diffLines, diffWords, lineStats, type DiffLine } from './words.mts';

export interface DeckSlideModel {
    index: number;
    title: string;
    layout: string;
    lines: string[];
}

export type SlideOp = 'equal' | 'changed' | 'added' | 'removed';

export interface SlidePair {
    op: SlideOp;
    left: { index: number; title: string; layout: string } | null;
    right: { index: number; title: string; layout: string } | null;
    layoutChanged: boolean;
    lines: DiffLine[];
    wordsAdded: number;
    wordsRemoved: number;
}

export interface LookChange { key: string; before: string; after: string; replaced?: boolean }

export interface DeckCompareResult {
    family: 'deck';
    slides: SlidePair[];
    look: LookChange[];
    summary: { changed: number; added: number; removed: number; unchanged: number; lookChanged: boolean; wordsAdded: number; wordsRemoved: number };
}

/** The deck shape this module reads (a subset of deckModel's normalised deck). */
interface AnySlide {
    title?: string | null;
    layout?: string | null;
    body?: string | null;
    bullets?: Array<{ text?: string; level?: number }>;
    table?: { columns?: unknown[]; rows?: unknown[][] } | null;
    chart?: { type?: string; title?: string; unit?: string; labels?: unknown[]; series?: Array<{ name?: string; values?: unknown[] }> } | null;
    stats?: Array<{ value?: unknown; label?: string; delta?: string }> | null;
    quote?: { text?: string; attribution?: string } | null;
    columns?: Array<{ title?: string; bullets?: Array<{ text?: string; level?: number }> }> | null;
    cards?: Array<{ title?: string; text?: string }> | null;
    steps?: Array<{ title?: string; text?: string }> | null;
    image?: { alt?: string } | null;
    notes?: string | null;
}
export interface AnyDeck { title?: string | null; subtitle?: string | null; slides?: AnySlide[] }

/** Slide pairs whose text shares at least this much are one slide, changed. */
export const SLIDE_MIN_SIMILARITY = 0.35;

const clean = (v: unknown): string => String(v ?? '').replace(/\s+/g, ' ').trim();
const bullet = (b: { text?: string; level?: number }) => `${b.level ? '    ' : ''}• ${clean(b.text)}`;

/** A slide's readable content, one line per thing a reader sees. */
export function slideLines(s: AnySlide): string[] {
    const out: string[] = [];
    const push = (v: unknown) => { const t = clean(v); if (t) out.push(t); };
    for (const line of String(s.body ?? '').split('\n')) push(line);
    const steps = s.steps || [];
    const bullets = s.bullets || [];
    if (steps.length && !bullets.length) steps.forEach((st, i) => push(`${i + 1}. ${clean(st.title)}${st.text ? ` — ${clean(st.text)}` : ''}`));
    else for (const b of bullets) push(bullet(b));
    if (s.table) {
        push((s.table.columns || []).map(clean).join(' | '));
        for (const r of s.table.rows || []) push((r || []).map(clean).join(' | '));
    }
    if (s.chart) {
        const c = s.chart;
        push(`Chart (${clean(c.type)})${c.title ? `: ${clean(c.title)}` : ''}${c.unit ? ` [${clean(c.unit)}]` : ''}`);
        push(`${(c.labels || []).map(clean).join(', ')}`);
        for (const ser of c.series || []) push(`${ser.name ? `${clean(ser.name)}: ` : ''}${(ser.values || []).map(clean).join(', ')}`);
    }
    for (const t of s.stats || []) push(`${clean(t.value)} — ${clean(t.label)}${t.delta ? ` (${clean(t.delta)})` : ''}`);
    if (s.quote) push(`“${clean(s.quote.text)}”${s.quote.attribution ? ` — ${clean(s.quote.attribution)}` : ''}`);
    for (const col of s.columns || []) {
        push(`▸ ${clean(col.title)}`);
        for (const b of col.bullets || []) push(bullet(b));
    }
    for (const c of s.cards || []) push(`${clean(c.title)}${c.title && c.text ? ': ' : ''}${clean(c.text)}`);
    if (s.image && clean(s.image.alt)) push(`[${clean(s.image.alt)}]`);
    if (clean(s.notes)) push(`Notes: ${clean(s.notes)}`);
    return out;
}

/** The cover (index 0) and every slide, as compared. */
export function deckSlides(deck: AnyDeck): DeckSlideModel[] {
    const cover: DeckSlideModel = { index: 0, title: clean(deck.title), layout: 'cover', lines: deck.subtitle ? [clean(deck.subtitle)] : [] };
    return [cover, ...(deck.slides || []).map((s, i) => ({ index: i + 1, title: clean(s.title), layout: clean(s.layout) || 'bullets', lines: slideLines(s) }))];
}

const titleKey = (s: DeckSlideModel): string | null => {
    if (s.index === 0) return '\u0000cover';
    const k = s.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    return k || null;
};
const slideText = (s: DeckSlideModel) => [s.title, ...s.lines].join('\n');
const head = (s: DeckSlideModel) => ({ index: s.index, title: s.title, layout: s.layout });

function pairOf(a: DeckSlideModel, b: DeckSlideModel): SlidePair {
    // A renamed slide shows its title as ONE changed line, however little the
    // two titles share: the slides were paired, so the titles are a pair too.
    const title: DiffLine[] = a.title === b.title ? [] : [{ op: 'modify', before: `# ${a.title}`, after: `# ${b.title}`, words: diffWords(`# ${a.title}`, `# ${b.title}`) }];
    const lines = [...title, ...diffLines(a.lines, b.lines)];
    const layoutChanged = a.layout !== b.layout;
    const changed = layoutChanged || lines.some((l) => l.op !== 'equal');
    return { op: changed ? 'changed' : 'equal', left: head(a), right: head(b), layoutChanged, lines, ...lineStats(lines) };
}

// ── The look ──────────────────────────────────────────────────────────

const LOOK_KEYS = ['preset', 'accent', 'background', 'text', 'titleFont', 'bodyFont', 'coverStyle', 'tableStyle', 'logoPlacement', 'slideNumbers', 'brandOnSlides', 'footerText'] as const;

/**
 * '' = not set by the deck (the house style decides), 'on' / 'off' for a
 * switch, else the value itself (a preset id, a colour, a font, the footer).
 */
function lookValue(look: Record<string, unknown>, key: string): string {
    const v = look[key];
    if (v === undefined || v === null || v === '') return '';
    return typeof v === 'boolean' ? (v ? 'on' : 'off') : clean(v);
}

/** A picture setting: '' (house style), 'none' (switched off) or 'custom', plus a fingerprint to tell two customs apart. */
function picture(v: unknown): { shown: string; print: string } {
    if (v === undefined || v === null || v === '') return { shown: '', print: '' };
    if (v === 'none') return { shown: 'none', print: 'none' };
    return { shown: 'custom', print: createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex') };
}

/**
 * Key by key. The template deck and the logo are pictures: compared by
 * fingerprint and reported as '' / 'none' / 'custom', with `replaced` when
 * both are custom but different. The pictures themselves never leave here.
 */
export function compareLook(left: Record<string, unknown>, right: Record<string, unknown>, houseStyle: { left: boolean; right: boolean }): LookChange[] {
    const out: LookChange[] = [];
    if (houseStyle.left !== houseStyle.right) out.push({ key: 'houseStyle', before: houseStyle.left ? 'on' : 'off', after: houseStyle.right ? 'on' : 'off' });
    for (const key of LOOK_KEYS) {
        const before = lookValue(left, key);
        const after = lookValue(right, key);
        if (before !== after) out.push({ key, before, after });
    }
    for (const key of ['template', 'logo']) {
        const before = picture(left[key]);
        const after = picture(right[key]);
        if (before.print !== after.print) {
            out.push({ key, before: before.shown, after: after.shown, ...(before.shown === after.shown ? { replaced: true } : {}) });
        }
    }
    return out;
}

export interface DeckSide {
    deck: AnyDeck;
    /** settings.deck, through normaliseDeckOverrides. */
    look: Record<string, unknown>;
    /** settings.houseStyle !== false */
    houseStyle: boolean;
}

export function compareDecks(left: DeckSide, right: DeckSide): DeckCompareResult {
    const a = deckSlides(left.deck);
    const b = deckSlides(right.deck);
    const steps = alignSequences(a, b, {
        keyA: titleKey,
        keyB: titleKey,
        similarity: (x, y) => bagSimilarity(slideText(x), slideText(y)),
        minSimilarity: SLIDE_MIN_SIMILARITY,
    });
    const slides: SlidePair[] = steps.map((s) => {
        if (s.op === 'match' || s.op === 'pair') return pairOf(s.a, s.b);
        if (s.op === 'delete') {
            const lines = diffLines([`# ${s.a.title}`, ...s.a.lines], []);
            return { op: 'removed', left: head(s.a), right: null, layoutChanged: false, lines, ...lineStats(lines) };
        }
        const lines = diffLines([], [`# ${s.b.title}`, ...s.b.lines]);
        return { op: 'added', left: null, right: head(s.b), layoutChanged: false, lines, ...lineStats(lines) };
    });
    const look = compareLook(left.look || {}, right.look || {}, { left: left.houseStyle, right: right.houseStyle });
    const count = (op: SlideOp) => slides.filter((p) => p.op === op).length;
    return {
        family: 'deck',
        slides,
        look,
        summary: {
            changed: count('changed'), added: count('added'), removed: count('removed'), unchanged: count('equal'),
            lookChanged: look.length > 0,
            wordsAdded: slides.reduce((n, p) => n + p.wordsAdded, 0),
            wordsRemoved: slides.reduce((n, p) => n + p.wordsRemoved, 0),
        },
    };
}
