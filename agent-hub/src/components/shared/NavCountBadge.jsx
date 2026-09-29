/**
 * NavCountBadge — the small count pill at the right of a nav row
 * ('Settings Nav.dc.html': the Compliance row carries "3" in warning ink).
 *
 * One rule matters more than the styling: an unknown count renders NOTHING.
 * `undefined`/`null` mean the endpoint has not answered (or withheld the key);
 * `0` means "nothing to do" — and a nav row with a "0" pill on it reads as
 * noise, so both collapse to null. A row shows a badge only when there is a
 * number worth acting on.
 *
 * Tones read the semantic status tokens only — never a hex literal, and
 * never the legacy per-status colour variables the artboards still carry:
 *   warning → border var(--warning), text var(--warning-ink)
 *   neutral → border var(--border-default), text var(--text-tertiary)
 */
import React from 'react';

const TONE_STYLE = {
    warning: { borderColor: 'var(--warning)', color: 'var(--warning-ink)' },
    error: { borderColor: 'var(--error)', color: 'var(--error-ink)' },
    success: { borderColor: 'var(--success)', color: 'var(--success-ink)' },
    neutral: { borderColor: 'var(--border-default)', color: 'var(--text-tertiary)' },
};

export function badgeCount(count) {
    const raw = typeof count === 'string' && count.trim() !== '' ? Number(count) : count;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
    // Floor BEFORE the threshold, not after: a fractional 0.9 is above zero
    // and would otherwise floor to 0 and put a "0" pill on the row — the one
    // thing this component exists to never do.
    const n = Math.floor(raw);
    return n > 0 ? n : null;
}

export default function NavCountBadge({ count, tone = 'neutral', max = 99, className = '', testId = 'nav-count-badge' }) {
    const n = badgeCount(count);
    if (n === null) return null;
    const style = TONE_STYLE[tone] || TONE_STYLE.neutral;
    const text = n > max ? `${max}+` : String(n);
    return (
        <span
            data-testid={testId}
            data-tone={tone in TONE_STYLE ? tone : 'neutral'}
            className={`inline-flex items-center justify-center rounded-full px-1.5 text-[10px] font-semibold tabular-nums leading-[16px] min-w-[18px] flex-shrink-0 ${className}`}
            style={{ border: '1px solid', borderColor: style.borderColor, color: style.color, background: 'transparent' }}
            aria-label={text}
        >
            {text}
        </span>
    );
}
