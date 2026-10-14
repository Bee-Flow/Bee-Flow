import { roleTextColor } from '../styleResolver';
import type { CSSProperties, ReactNode } from 'react';
import { ROLE_HEX } from './cellTone';

/** A soft wash in the role's hue, with text readable on it. Mirrors AppList. */
function pillStyle(tone: string | null | undefined): CSSProperties {
    if (!tone || tone === 'neutral' || !ROLE_HEX[tone]) {
        return { background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' };
    }
    return {
        background: `color-mix(in srgb, ${ROLE_HEX[tone]} 16%, transparent)`,
        color: roleTextColor(tone),
    };
}
interface PillProps {
    children?: ReactNode;
    tone?: string | null;
    dot?: boolean;
}

export function Pill({ children, tone, dot = false }: PillProps) {
    return (
        <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium${dot ? ' gap-1' : ''}`}
            style={pillStyle(tone)}
            data-app-cell-tone={tone || 'neutral'}
        >
            {/* badgeStyle:'dot' — the pill keeps its wash, the dot carries the
                tone at full strength (a 16% wash alone is hard to tell apart
                across a column of pills). */}
            {dot ? (
                <span
                    aria-hidden="true"
                    className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ background: (tone && tone !== 'neutral' && ROLE_HEX[tone]) || 'var(--text-muted)' }}
                    data-app-cell-dot={tone || 'neutral'}
                />
            ) : null}
            {children}
        </span>
    );
}
/**
 * A small uppercase marker beside the main text (spec: columns[].flagFrom) —
 * the SPOED case: one word that must be seen before the description is read,
 * without spending a whole column on it.
 */
interface CellFlagProps {
    text: string;
    tone: string;
}

export function CellFlag({ text, tone }: CellFlagProps) {
    const t = ROLE_HEX[tone] ? tone : 'warning';
    return (
        <span
            className="inline-flex shrink-0 items-center rounded px-1 font-semibold uppercase tracking-wide"
            style={{
                fontSize: 10.5,
                background: `color-mix(in srgb, ${ROLE_HEX[t]} 16%, transparent)`,
                color: roleTextColor(t),
            }}
            data-app-cell-flag={t}
        >
            {text}
        </span>
    );
}
/** Up to two initials — "Anna de Vries" → AV, "chidi" → C. */
export function initialsOf(name: unknown): string {
    const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
    return (parts[0].slice(0, 1) + parts[parts.length - 1].slice(0, 1)).toUpperCase();
}

const MONOGRAM_TONES = ['primary', 'info', 'success', 'warning', 'danger'];

/**
 * A person's face without a photo.
 *
 * The tone is picked from the NAME, not at random, so the same colleague keeps
 * the same colour on every screen and across reloads — a monogram that changed
 * hue per render would be worse than no colour at all.
 */
export function Monogram({ name, size = 20 }: { name: unknown; size?: number }) {
    const label = String(name ?? '');
    let hash = 0;
    for (let i = 0; i < label.length; i += 1) hash = (hash * 31 + label.charCodeAt(i)) % 997;
    const tone = MONOGRAM_TONES[hash % MONOGRAM_TONES.length];
    return (
        <span
            aria-hidden="true"
            className="inline-flex shrink-0 items-center justify-center rounded-full font-medium"
            style={{ ...pillStyle(tone), width: size, height: size, fontSize: Math.round(size * 0.45) }}
            data-app-cell-monogram={tone}
        >
            {initialsOf(label)}
        </span>
    );
}
