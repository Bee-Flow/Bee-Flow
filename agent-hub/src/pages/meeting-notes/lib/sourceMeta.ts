import { MessageSquare, Video, Cloud, type LucideIcon } from 'lucide-react';

/**
 * Source chips read theme tokens, never a brand hex (Bee Flow Builder
 * redesign, Sep 2026: the repo-wide token hygiene test rejects any literal
 * colour). Nextcloud/Talk keep a blue and Meet a green so the two capture
 * paths stay tellable apart at a glance, but the values follow the theme:
 *   - Talk / Nextcloud → `--type-ai`  (the theme's blue)
 *   - Google Meet      → `--success`  (the theme's green)
 * Consumers paint the chip as `color-mix(in srgb, <color> 12%, transparent)`
 * with the same colour for the glyph, so a token here re-tints every chip.
 */
const SOURCE_META: Record<string, { label: string; color: string; Icon: LucideIcon; title?: string }> = {
    talk: { label: 'Talk', color: 'var(--type-ai)', Icon: MessageSquare },
    'talk-auto': { label: 'Talk', color: 'var(--type-ai)', Icon: MessageSquare, title: 'Imported automatically' },
    gmeet: { label: 'Meet', color: 'var(--success)', Icon: Video },
    nextcloud: { label: 'Nextcloud', color: 'var(--type-ai)', Icon: Cloud },
};

/**
 * Badge metadata for a transcription's `source`. Returns null for plain
 * uploads / live recordings (and unknown values) — those get no chip.
 */
export function getSourceMeta(source: string | undefined) {
    return (source ? SOURCE_META[source] : undefined) || null;
}
