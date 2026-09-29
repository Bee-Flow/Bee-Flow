import React from 'react';
import { TONES } from '../../../shared/statusTone';

/**
 * StatusPill — the toned status chip of the Compliance Center (redesign,
 * Sep 2026): the header's "Een paar punten vragen aandacht · 7 open", the
 * attention card's "7", a framework card's "vanaf 9 dec 2026 · over 86
 * dagen". Passed as the `statusChip` ELEMENT to `StudioSectionHeader`, or
 * used inline in a card.
 *
 * One recipe, the tone PAIR from statusTone: `border: 1px solid raw`,
 * `color: ink` — the raw token draws the hairline, the ink token is the
 * text (the raw colour as text measures under 4:1 on a light card; see the
 * ink docblock in src/index.css). `neutral` is the "nothing to say" pill:
 * `--border-default` hairline, secondary text. No fill: the artboard's
 * ink-filled pills were rejected for interactive elements (2026-09-03), and
 * a status pill stays a hairline so it never competes with the primary
 * action beside it.
 *
 * Props
 *   tone      'success' | 'warning' | 'error' | 'neutral' (default neutral)
 *   icon      a lucide component or a ready element, drawn at 11px
 *   children  the words
 *   className / testId / title  pass-through
 */
export default function StatusPill({ tone = 'neutral', icon, children, className = '', testId = 'status-pill', title }) {
    const key = TONES[tone] ? tone : 'neutral';
    const style = key === 'neutral'
        ? { border: '1px solid var(--border-default)', color: 'var(--text-secondary)' }
        : { border: `1px solid ${TONES[key].raw}`, color: TONES[key].ink };

    return (
        <span
            data-testid={testId}
            data-tone={key}
            title={title}
            className={`inline-flex items-center gap-1.5 text-[11px] font-semibold px-2 py-[3px] rounded-full whitespace-nowrap ${className}`}
            style={style}
        >
            {renderIcon(icon)}
            {children}
        </span>
    );
}

function renderIcon(icon) {
    if (!icon) return null;
    if (React.isValidElement(icon)) return icon;
    const Icon = icon;
    return <Icon style={{ width: 11, height: 11 }} aria-hidden="true" />;
}
