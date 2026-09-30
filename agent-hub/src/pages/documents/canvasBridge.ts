// The editor's half of the designed-document frame protocol. The frame's half
// is server/services/documentEditBridge.js, where every message is listed;
// this module is the types, the parsing of what the frame sends, and the one
// piece of HTML work the editor does itself: taking sections out of a freshly
// composed (server-sanitised) preview, so changes by others can be put into
// the frame without reloading it under somebody's caret.

import type { CommentAnchor } from '../../api/queries/comments';

export interface OutlineItem {
    index: number;
    level: number;
    text: string;
    sectionId: string | null;
}

export interface FrameStats {
    words: number;
    pages: number;
    text: string;
}

export interface FramePeer {
    sectionId: string;
    label: string;
    /** The person's co-editing colour (editor/collab/colors), as #rrggbb. */
    colour: string;
}

export type FrameKey = 'save' | 'find' | 'history' | 'comment' | 'escape' | 'help';

export type FrameMessage =
    | { kind: 'ready' }
    | { kind: 'deckReady'; slideCount: number }
    | { kind: 'dirty'; html: string; requestId?: string }
    | { kind: 'caret'; sectionId: string | null }
    | { kind: 'outline'; items: OutlineItem[] }
    | { kind: 'stats'; stats: FrameStats }
    | { kind: 'selection'; anchor: CommentAnchor | null }
    | { kind: 'found'; count: number; index: number }
    | { kind: 'patched'; applied: string[]; missing: string[] }
    | { kind: 'scrolled'; y: number }
    | { kind: 'key'; key: FrameKey };

const KEYS: ReadonlySet<string> = new Set(['save', 'find', 'history', 'comment', 'escape', 'help']);
const str = (v: unknown, max = 500): string => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 200) : []);

function parseAnchor(raw: any): CommentAnchor | null {
    if (!raw || typeof raw !== 'object' || typeof raw.quote !== 'string' || !raw.quote) return null;
    return {
        quote: str(raw.quote),
        prefix: str(raw.prefix, 64),
        suffix: str(raw.suffix, 64),
        blockIndex: Math.max(0, Math.floor(num(raw.blockIndex))),
        ...(typeof raw.sectionId === 'string' && raw.sectionId ? { sectionId: str(raw.sectionId, 100) } : {}),
    };
}

type Parser = (d: Record<string, any>) => FrameMessage | null;

function parseOutline(d: Record<string, any>): FrameMessage | null {
    if (!Array.isArray(d.items)) return null;
    return {
        kind: 'outline',
        items: d.items.slice(0, 300).map((it: any, i: number) => ({
            index: Math.floor(num(it?.index ?? i)),
            level: Math.min(3, Math.max(1, Math.floor(num(it?.level)) || 1)),
            text: str(it?.text, 120),
            sectionId: typeof it?.sectionId === 'string' ? str(it.sectionId, 100) : null,
        })),
    };
}

/** One parser per marker key the frame sets on its message. */
const PARSERS: Array<[string, Parser]> = [
    ['__beeflowDocReady', () => ({ kind: 'ready' })],
    ['__beeflowDeckReady', (d) => ({ kind: 'deckReady', slideCount: Math.max(0, Math.floor(num(d.slideCount))) })],
    ['__beeflowDocDirty', (d) => (typeof d.html === 'string'
        ? { kind: 'dirty', html: d.html, ...(typeof d.requestId === 'string' ? { requestId: d.requestId } : {}) }
        : null)],
    ['__beeflowDocCaret', (d) => ({ kind: 'caret', sectionId: typeof d.sectionId === 'string' ? str(d.sectionId, 100) : null })],
    ['__beeflowDocOutline', parseOutline],
    ['__beeflowDocStats', (d) => ({ kind: 'stats', stats: { words: num(d.words), pages: Math.max(1, num(d.pages)), text: str(d.text, 200_000) } })],
    ['__beeflowDocSelection', (d) => ({ kind: 'selection', anchor: parseAnchor(d.anchor) })],
    ['__beeflowDocFound', (d) => ({ kind: 'found', count: num(d.count), index: num(d.index) })],
    ['__beeflowDocPatched', (d) => ({ kind: 'patched', applied: ids(d.applied), missing: ids(d.missing) })],
    ['__beeflowDocScrolled', (d) => ({ kind: 'scrolled', y: num(d.y) })],
    ['__beeflowDocKey', (d) => (KEYS.has(d.key) ? { kind: 'key', key: d.key as FrameKey } : null)],
];

/**
 * What a message from the frame means, or null for anything that is not the
 * bridge speaking. The caller has already checked the message came from ITS
 * frame (event.source); this checks the shape, since a document's content
 * runs in that frame too.
 */
export function parseFrameMessage(data: unknown): FrameMessage | null {
    if (!data || typeof data !== 'object') return null;
    const d = data as Record<string, any>;
    const entry = PARSERS.find(([marker]) => d[marker] === true);
    return entry ? entry[1](d) : null;
}

/**
 * The inner HTML of the named sections, out of a composed preview. Parsed
 * with DOMParser, which runs nothing; the HTML is the server's sanitised
 * composition, the same bytes the frame loads on a reload.
 */
export function extractSections(composedHtml: string, sectionIds: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    if (!sectionIds.length) return out;
    const doc = new DOMParser().parseFromString(composedHtml, 'text/html');
    for (const el of Array.from(doc.body.querySelectorAll('[data-doc-section]'))) {
        const id = el.getAttribute('data-doc-section');
        if (id && sectionIds.includes(id) && !(id in out)) out[id] = el.innerHTML;
    }
    return out;
}

/** The theme's desk colour, for the frame's background. */
export function deskColour(): string {
    try {
        return getComputedStyle(document.documentElement).getPropertyValue('--bg-tertiary').trim();
    } catch {
        return '';
    }
}

export type MergePart =
    | { kind: 'clean'; html: string }
    | { kind: 'conflict'; key: string; label: string; base: string; mine: string; theirs: string };

/** The body chosen in "compare and choose" (the server's resolveParts, here). */
export function resolveParts(parts: MergePart[], choices: Record<string, 'mine' | 'theirs'>): string {
    return parts.map((p) => (p.kind === 'clean' ? p.html : (choices[p.key] === 'theirs' ? p.theirs : p.mine))).join('');
}
