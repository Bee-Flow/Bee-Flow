/**
 * The sitemap's graph and layout, pure: which pages link where, and where
 * each card goes. See SitemapView for the picture.
 */

// ── Layout constants ─────────────────────────────────────────────────

export const NODE_W = 200;
export const NODE_H = 78;
const RANK_GAP = 90;        // vertical gap between rank rows (above NODE_H)
const COL_GAP = 36;         // horizontal gap between cards in a rank
export const PADDING = 64;  // outer canvas padding
const ORPHAN_GAP = 60;      // gap above the orphan row
export const CHROME_W = 160;
export const CHROME_H = 30;
const CHROME_GAP = 60;      // gap between chrome pseudo-node and homepage
export const DRAG_THRESHOLD = 8;   // px movement before a mousedown becomes a drag

export interface Point {
    x: number;
    y: number;
}

/** One entry of the SiteDoc's page index. */
export interface SitemapPageEntry {
    id: string;
    title?: string;
    slug?: string;
    isHomepage?: boolean;
    [key: string]: unknown;
}

/** One page of the sitemap: its index entry with its PageDoc's blocks merged in. */
export interface SitemapPage extends SitemapPageEntry {
    blocks: Array<{ id?: string; type?: string; [key: string]: unknown }>;
}

export interface SitemapSite {
    pages?: SitemapPageEntry[];
    header?: { nav?: Array<{ id?: string; label?: string; link?: { kind?: string; pageId?: string } } | null>; [key: string]: unknown };
    footer?: unknown;
    [key: string]: unknown;
}

export interface InternalEdge {
    source: string;
    target: string;
}

export interface SitemapLayout {
    positions: Map<string, Point>;
    /** Tree parent per page, for edge classification. */
    parent: Map<string, string>;
    /** Only when chrome targets exist. */
    chromePos: Point | null;
    /** Pages the BFS never reached. */
    orphanIds: Set<string>;
    orphanRowY: number;
    canvasWidth: number;
    canvasHeight: number;
    homepageId: string | null;
}

// ── Graph derivation helpers ─────────────────────────────────────────

/**
 * Every page-kind link target found in the header + footer.
 *   targets : the page ids
 *   sources : pageId → where each link sits (for the info popover)
 */
export function collectChromeTargets(site: SitemapSite | null | undefined) {
    const targets = new Set<string>();
    const sources = new Map<string, Array<{ location: string }>>();
    const walk = (location: string, node: unknown): void => {
        if (Array.isArray(node)) { node.forEach(n => walk(location, n)); return; }
        if (!node || typeof node !== 'object') return;
        const n = node as { kind?: string; pageId?: string };
        if (n.kind === 'page' && n.pageId) {
            targets.add(n.pageId);
            if (!sources.has(n.pageId)) sources.set(n.pageId, []);
            (sources.get(n.pageId) as Array<{ location: string }>).push({ location });
        }
        for (const v of Object.values(node)) walk(location, v);
    };
    walk('header', site?.header);
    walk('footer', site?.footer);
    return { targets, sources };
}

/**
 * Walk every block on every page; emit (source, target) per page-kind link.
 *   edges : deduped by pair
 *   meta  : "src->tgt" → which blocks define it
 */
export function collectInternalEdges(pages: SitemapPage[]) {
    const edges: InternalEdge[] = [];
    const seen  = new Set<string>();
    const meta  = new Map<string, Array<{ blockType?: string; blockId?: string }>>();
    const addEdge = (source: string, target: string, blockType?: string, blockId?: string) => {
        if (!source || !target || source === target) return;
        const k = `${source}->${target}`;
        if (!seen.has(k)) {
            seen.add(k);
            edges.push({ source, target });
        }
        if (!meta.has(k)) meta.set(k, []);
        const existing = meta.get(k) as Array<{ blockType?: string; blockId?: string }>;
        if (!existing.some(e => e.blockId === blockId)) {
            existing.push({ blockType, blockId });
        }
    };
    const walk = (sourceId: string, blockType: string | undefined, blockId: string | undefined, node: unknown): void => {
        if (Array.isArray(node)) { node.forEach(n => walk(sourceId, blockType, blockId, n)); return; }
        if (!node || typeof node !== 'object') return;
        const n = node as { kind?: string; pageId?: string };
        if (n.kind === 'page' && n.pageId) addEdge(sourceId, n.pageId, blockType, blockId);
        for (const v of Object.values(node)) walk(sourceId, blockType, blockId, v);
    };
    for (const page of pages) {
        (page.blocks || []).forEach(block => walk(page.id, block.type, block.id, block));
    }
    return { edges, meta };
}

/** Width of one row of `count` cards. */
const rowWidth = (count: number) => count * NODE_W + Math.max(0, count - 1) * COL_GAP;

/** Rank per page: homepage 0, chrome targets 1, then BFS through internal edges. */
function assignRanks(homepage: SitemapPage | null, internalEdges: InternalEdge[], chromeTargets: Set<string>) {
    const outgoing = new Map<string, string[]>();
    for (const e of internalEdges) {
        if (!outgoing.has(e.source)) outgoing.set(e.source, []);
        (outgoing.get(e.source) as string[]).push(e.target);
    }

    const rank   = new Map<string, number>();
    const parent = new Map<string, string>();
    const queue: string[] = [];

    if (homepage) {
        rank.set(homepage.id, 0);
        queue.push(homepage.id);
        // Chrome targets become rank-1 children of the homepage.
        for (const t of chromeTargets) {
            if (t === homepage.id || rank.has(t)) continue;
            rank.set(t, 1);
            parent.set(t, homepage.id);
            queue.push(t);
        }
    }

    // BFS through internal edges.
    let cursor = 0;
    while (cursor < queue.length) {
        const id = queue[cursor++];
        const idRank = rank.get(id)!;
        const children = outgoing.get(id) || [];
        for (const child of children) {
            if (rank.has(child)) continue;
            rank.set(child, idRank + 1);
            parent.set(child, id);
            queue.push(child);
        }
    }
    return { rank, parent };
}

/** Place one row of cards centred on `centerX` at height `y`. */
function placeRow(positions: Map<string, Point>, items: SitemapPage[], centerX: number, y: number) {
    const startX = centerX - rowWidth(items.length) / 2;
    items.forEach((p, idx) => {
        positions.set(p.id, { x: startX + idx * (NODE_W + COL_GAP), y });
    });
}

/**
 * BFS rank assignment from the homepage. Chrome targets seed rank 1 (the
 * homepage's "nav children"). Internal edges extend the tree from there.
 * Pages never visited become orphans, in a row of their own at the bottom.
 */
export function bfsLayout(pages: SitemapPage[], internalEdges: InternalEdge[], chromeTargets: Set<string>): SitemapLayout {
    const homepage = pages.find(p => p.isHomepage) || pages[0] || null;
    const { rank, parent } = assignRanks(homepage, internalEdges, chromeTargets);

    // Bucket pages by rank.
    const byRank = new Map<number, SitemapPage[]>();
    const orphanIds = new Set<string>();
    for (const p of pages) {
        if (rank.has(p.id)) {
            const r = rank.get(p.id) as number;
            if (!byRank.has(r)) byRank.set(r, []);
            (byRank.get(r) as SitemapPage[]).push(p);
        } else {
            orphanIds.add(p.id);
        }
    }
    const orphans = pages.filter(p => orphanIds.has(p.id));
    const ranks = Array.from(byRank.keys()).sort((a, b) => a - b);

    // Canvas width — widest row drives it. Plus padding.
    let widestRow = NODE_W;
    for (const items of byRank.values()) widestRow = Math.max(widestRow, rowWidth(items.length));
    if (orphans.length > 0) widestRow = Math.max(widestRow, rowWidth(orphans.length));
    const canvasWidth = widestRow + 2 * PADDING;
    const centerX = canvasWidth / 2;

    // Reserve space above rank 0 for the chrome pseudo-node when present.
    const hasChrome = chromeTargets.size > 0;
    const topPad = PADDING + (hasChrome ? CHROME_H + CHROME_GAP : 0);

    const positions = new Map<string, Point>();
    for (const r of ranks) placeRow(positions, byRank.get(r)!, centerX, topPad + r * (NODE_H + RANK_GAP));

    const maxPageRank = ranks.length > 0 ? ranks[ranks.length - 1] : 0;
    const bottomOfTree = topPad + maxPageRank * (NODE_H + RANK_GAP) + NODE_H;

    // Orphan row at the bottom.
    let orphanRowY = 0;
    if (orphans.length > 0) {
        orphanRowY = bottomOfTree + ORPHAN_GAP;
        placeRow(positions, orphans, centerX, orphanRowY);
    }

    // Chrome pseudo-node centred above the homepage.
    let chromePos: Point | null = null;
    const hpPos = hasChrome && homepage ? positions.get(homepage.id) : undefined;
    if (hpPos) {
        chromePos = {
            x: hpPos.x + (NODE_W - CHROME_W) / 2,
            y: hpPos.y - CHROME_H - CHROME_GAP,
        };
    }

    const canvasHeight = (orphans.length > 0 ? orphanRowY + NODE_H : bottomOfTree) + PADDING;

    return {
        positions,
        parent,
        chromePos,
        orphanIds,
        orphanRowY,
        canvasWidth,
        canvasHeight,
        homepageId: homepage?.id || null,
    };
}

/**
 * Edge endpoint geometry — shorten the line so the arrowhead lands on the card
 * edge, not its centre. For top-down trees most edges go roughly downward —
 * start from the bottom of the source rect's centre, end at the top of the
 * target's. Lateral / upward edges (backlinks) still anchor on the centre and
 * let the visual handle it — good enough for the read-only graph.
 */
export function edgeEndpoints(srcCx: number, srcCy: number, srcH: number, tgtCx: number, tgtCy: number, tgtH: number) {
    const sx = srcCx;
    const sy = srcCy + srcH / 2 - 2;
    const ex = tgtCx;
    const ey = tgtCy - tgtH / 2 + 2;
    return { sx, sy, ex, ey };
}

/** An internal edge either follows the BFS tree or is a backlink. */
export function classifyInternal(edge: InternalEdge, parent: Map<string, string>): 'tree' | 'backlink' {
    return parent.get(edge.target) === edge.source ? 'tree' : 'backlink';
}

/**
 * Throw a useful Error when a CMS response isn't ok — the body's `error`
 * field when present, else a status-coded fallback. Shared by the initial
 * load and every mutation handler so the not-ok boilerplate lives once.
 */
export async function ensureOk(res: Response, fallback: string): Promise<void> {
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `${fallback} (${res.status})`);
    }
}
