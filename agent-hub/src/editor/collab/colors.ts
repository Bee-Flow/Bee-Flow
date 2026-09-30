/**
 * colors.ts — one stable colour per co-editor.
 *
 * A person keeps the same colour in every document and every session: it is
 * derived from the user id, not from the (per-tab) Yjs client id, so "the
 * orange caret" means the same colleague tomorrow. Eight hues, none of them
 * purple, violet or indigo; each has a matching `.bf-peer-N` class in
 * editor.css that sets `--bf-peer` (caret, name flag, selection tint), so no
 * component needs an inline colour.
 */

export const PEER_COLORS = [
    '#0284c7', // sky
    '#059669', // emerald
    '#d97706', // amber
    '#e11d48', // rose
    '#0d9488', // teal
    '#ea580c', // orange
    '#65a30d', // lime
    '#db2777', // pink
] as const;

export const PEER_COLOR_COUNT = PEER_COLORS.length;

/** FNV-1a over the id's UTF-16 code units: small, stable, well spread. */
function hash(text: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
}

/** Palette slot for a user id (0 … PEER_COLOR_COUNT-1). */
export function peerColorIndex(userId: string | null | undefined): number {
    if (!userId) return 0;
    return hash(String(userId)) % PEER_COLOR_COUNT;
}

/** Hex colour for a user id (avatars, anything that cannot use the class). */
export function peerColor(userId: string | null | undefined): string {
    return PEER_COLORS[peerColorIndex(userId)];
}

/** The class that sets `--bf-peer` for a user id. */
export function peerClass(userId: string | null | undefined): string {
    return `bf-peer-${peerColorIndex(userId)}`;
}

/** CSS Custom Highlight name for a palette slot (see editor.css). */
export function peerHighlightName(index: number): string {
    return `bf-peer-sel-${((index % PEER_COLOR_COUNT) + PEER_COLOR_COUNT) % PEER_COLOR_COUNT}`;
}
