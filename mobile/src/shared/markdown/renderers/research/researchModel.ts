/**
 * A ```json-research report, read into a typed tree. The schema is the one
 * the web's ResearchRenderer documents for agents (its header comment):
 * `{ title, blocks[] }` with hero, markdown|text, image, sources, callout,
 * stats, columns, divider and section blocks, and a block of any other type
 * that carries `content` or `text` shown as Markdown.
 *
 * Model output is untrusted JSON, so every field is read defensively: a
 * wrong-typed field is treated as absent, and a block with no type is
 * dropped — the web renders nothing for it either.
 */

import { lookup } from '../lookup';

export type CalloutVariant = 'info' | 'warning' | 'success' | 'tip';

export interface ResearchSource {
    url: string;
    title: string;
}

export interface ResearchStat {
    value: string;
    label: string;
    /** A CSS colour or gradient the model chose; '' for the default. */
    color: string;
}

export type ResearchBlock =
    | { type: 'hero'; title: string; subtitle: string; image: string; date: string }
    | { type: 'markdown'; content: string }
    | { type: 'image'; src: string; alt: string; caption: string; credit: string; height: number | null; fit: 'cover' | 'contain' }
    | { type: 'sources'; items: ResearchSource[] }
    | { type: 'callout'; variant: CalloutVariant; title: string; content: string }
    | { type: 'stats'; items: ResearchStat[] }
    | { type: 'columns'; columns: number; children: ResearchBlock[] }
    | { type: 'divider' }
    | { type: 'section'; title: string; children: ResearchBlock[] };

export interface ResearchReport {
    title: string;
    blocks: ResearchBlock[];
}

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string =>
    typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const CALLOUTS: readonly CalloutVariant[] = ['info', 'warning', 'success', 'tip'];

function readSource(item: unknown): ResearchSource | null {
    if (!isRecord(item) || !text(item.url)) return null;
    return { url: text(item.url), title: text(item.title) };
}

function readStat(item: unknown): ResearchStat | null {
    if (!isRecord(item)) return null;
    return { value: text(item.value), label: text(item.label), color: text(item.color) };
}

function children(block: Json, depth: number): ResearchBlock[] {
    const raw = Array.isArray(block.children) ? block.children : list(block.blocks);
    return depth > 8 ? [] : readBlocks(raw, depth + 1);
}

type Reader = (block: Json, depth: number) => ResearchBlock | null;

const READERS: Record<string, Reader> = {
    hero: (b) => ({ type: 'hero', title: text(b.title), subtitle: text(b.subtitle), image: text(b.image), date: text(b.date) }),
    markdown: (b) => ({ type: 'markdown', content: text(b.content) || text(b.text) }),
    image: (b) => {
        const src = text(b.src) || text(b.url);
        if (!src) return null;
        const height = typeof b.height === 'number' && b.height > 0 ? b.height : null;
        const fit = b.fit === 'contain' ? 'contain' : 'cover';
        return { type: 'image', src, alt: text(b.alt), caption: text(b.caption), credit: text(b.credit), height, fit };
    },
    sources: (b) => {
        const items = list(b.items).map(readSource).filter((s): s is ResearchSource => s !== null);
        return items.length ? { type: 'sources', items } : null;
    },
    callout: (b) => {
        const variant = CALLOUTS.find((v) => v === b.variant) ?? 'info';
        return { type: 'callout', variant, title: text(b.title), content: text(b.content) || text(b.text) };
    },
    stats: (b) => ({ type: 'stats', items: list(b.items).map(readStat).filter((s): s is ResearchStat => s !== null) }),
    columns: (b, depth) => {
        const kids = children(b, depth);
        const columns = typeof b.columns === 'number' && b.columns > 0 ? b.columns : kids.length || 2;
        return { type: 'columns', columns: Math.min(columns, 3), children: kids };
    },
    divider: () => ({ type: 'divider' }),
    section: (b, depth) => ({ type: 'section', title: text(b.title), children: children(b, depth) }),
};
READERS.text = READERS.markdown as Reader;

function readBlock(raw: unknown, depth: number): ResearchBlock | null {
    if (!isRecord(raw) || typeof raw.type !== 'string' || !raw.type) return null;
    const reader = lookup(READERS, raw.type);
    if (reader) return reader(raw, depth);
    // The web's default: anything with words is shown as Markdown.
    const content = text(raw.content) || text(raw.text);
    return content ? { type: 'markdown', content } : null;
}

function readBlocks(raw: unknown[], depth: number): ResearchBlock[] {
    return raw.map((b) => readBlock(b, depth)).filter((b): b is ResearchBlock => b !== null);
}

export function readResearch(source: string): ResearchReport | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(source);
    } catch {
        return null;
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.blocks)) return null;
    return { title: text(parsed.title), blocks: readBlocks(parsed.blocks, 0) };
}

/** The web's getDomain: the host without `www.`, or the text itself when it is not a URL. */
export function sourceDomain(url: string): string {
    try {
        return new URL(url).hostname.replace('www.', '');
    } catch {
        return url;
    }
}
