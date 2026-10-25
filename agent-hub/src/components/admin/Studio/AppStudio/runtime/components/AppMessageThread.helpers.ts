import { walkPath } from '../resolveBinding';
import { roleFillContrast } from '../styleResolver';
import { ROLE_COLORS } from '../styleResolver.constants';
import { displayValue } from '../uiBits';

export function toneStyle(side: string, tone: string | null) {
    if (side === 'center') {
        return { background: 'transparent', color: 'var(--text-muted)', border: 'none' };
    }
    // 'neutral' is the incoming default: a plain surface bubble. Any other role
    // tints the bubble so the eye can separate the two parties at a glance.
    if (!tone || tone === 'neutral') {
        return { background: 'var(--bg-tertiary)', color: 'var(--text-primary)' };
    }
    const color = ROLE_COLORS[tone] || ROLE_COLORS.primary;
    // OUR side gets a filled bubble, not a 14% wash of one. That wash is the
    // difference between "a chat with two clearly different voices" and "a list
    // of grey boxes, one very slightly warmer" — which is what every screenshot
    // of this component actually looked like.
    if (side === 'right') {
        // White was hardcoded on the raw role colour, so a warning/info/success
        // bubble printed its text at well under 4.5:1.
        return { background: color, color: roleFillContrast(tone) };
    }
    return { background: `color-mix(in srgb, ${color} 14%, transparent)`, color: 'var(--text-primary)' };
}

export function formatStamp(value: unknown) {
    if (value == null || value === '') return null;
    const d = new Date(value as string | number | Date);
    if (Number.isNaN(d.getTime())) return displayValue(value);
    return d.toLocaleString();
}

/** Whitespace-only text is empty text — let displayValue print the em dash. */
export const textOrNull = (text: unknown) => (typeof text === 'string' && !text.trim() ? null : text);

/** Up to two initials from an author name, for the mail-header avatar. */
export function initials(name: unknown) {
    const s = typeof name === 'string' ? name.trim() : '';
    if (!s) return '?';
    const parts = s.split(/\s+/).filter(Boolean);
    const first = parts[0]?.[0] || '';
    const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
    return (first + last).toUpperCase() || '?';
}

/** The sideMap entry matching this row, or a left/neutral default. */
export function resolveSide(row: Record<string, unknown>, sideField: string | null, sideMap: { value: string; side: string; tone: string }[]) {
    if (!sideField) return { side: 'left', tone: 'neutral' };
    const raw = walkPath(row, sideField);
    const value = raw == null ? '' : String(raw);
    const hit = (Array.isArray(sideMap) ? sideMap : []).find((m) => m && String(m.value) === value);
    return {
        side: hit?.side === 'right' || hit?.side === 'center' ? hit.side : 'left',
        tone: hit?.tone || 'neutral',
    };
}
