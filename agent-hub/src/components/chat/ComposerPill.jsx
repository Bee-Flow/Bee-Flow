/**
 * ComposerPill — one small statement in the composer's toolbar.
 *
 * The composer collapsed its eight loose icons into a single "+" menu, which
 * fixed the clutter and cost the box its ability to say anything about itself:
 * a wordless gauge and a "+" tell you nothing about which depth the next answer
 * runs at, or that three skills are attached. The pills bring the WORDS back
 * without bringing the icon row back — a pill names one thing, in the colour
 * that thing already wears everywhere else in the product (kindColors.js), and
 * there are never more than a handful.
 *
 * Two shapes, and the difference is load-bearing:
 *
 *   STATEMENT (no `onClick`) — a <span>. It reports something the user cannot
 *     change from here: the tier an agent was saved with, how many notebook
 *     sources this chat can reach. No chevron, no hover, not focusable, so it
 *     never promises a picker that does not exist.
 *
 *   CONTROL (with `onClick`) — a <button> with a chevron that opens the picker
 *     the pill names. Exactly ONE control may own a given picker's open state;
 *     a pill and a row in the "+" menu both driving `skillsOpen` is how you get
 *     "the picker will not open" (one opens it, the other closes it again).
 *     A pill that takes a picker over therefore removes its row from
 *     `composerTools`.
 *
 * Colours come from kindColors — `var(--kind-skill)`, `var(--kind-kb)`,
 * `var(--type-ai)` — never a hex, so the pills follow the theme at paint time.
 *
 * Deliberately dumb: it renders `label`, which the caller has already put
 * through t(). It resolves no state and makes no claim of its own, so a caller
 * that cannot substantiate a claim simply renders nothing.
 */

import { ChevronDown } from 'lucide-react';
import React from 'react';

import { kindColorVar, kindIcon, kindTint } from '../shared/kindColors';

/** One shape for both, so a statement and a control cannot look different. */
function pillStyle(kind, { open, interactive, compact }) {
    return {
        display: 'inline-flex', alignItems: 'center', gap: compact ? '4px' : '5px',
        maxWidth: '100%', minWidth: 0,
        height: compact ? '24px' : '26px',
        padding: compact ? '0 7px' : '0 8px',
        borderRadius: '9999px',
        border: '1px solid transparent',
        background: open ? kindTint(kind, 20) : kindTint(kind, 11),
        color: 'var(--text-primary)',
        font: 'inherit',
        fontSize: compact ? '11px' : '12px',
        lineHeight: 1,
        cursor: interactive ? 'pointer' : 'default',
        transition: 'background 0.15s ease',
    };
}

export default function ComposerPill({
    kind,
    label,
    count = null,
    onClick = null,
    open = false,
    title,
    testId,
    compact = false,
}) {
    const Icon = kindIcon(kind);
    const interactive = typeof onClick === 'function';
    const showCount = typeof count === 'number' && count > 0;
    const style = pillStyle(kind, { open, interactive, compact });

    const body = (
        <>
            {Icon && (
                // kindIcon() looks a component up in a frozen module-level
                // table; nothing is constructed per render, so the rule's
                // "created during render" reading does not hold here.
                // eslint-disable-next-line react-hooks/static-components
                <Icon
                    aria-hidden="true"
                    className={compact ? 'w-3 h-3' : 'w-3.5 h-3.5'}
                    style={{ color: kindColorVar(kind), flexShrink: 0 }}
                />
            )}
            <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {label}
            </span>
            {showCount && (
                <span
                    data-testid={testId ? `${testId}-count` : undefined}
                    style={{
                        fontSize: '10px', fontWeight: 700, lineHeight: '15px',
                        minWidth: '15px', height: '15px', padding: '0 4px', borderRadius: '9999px',
                        textAlign: 'center', flexShrink: 0,
                        background: kindColorVar(kind), color: 'var(--bg-primary)',
                    }}
                >{count}</span>
            )}
            {interactive && (
                <ChevronDown
                    aria-hidden="true"
                    className="w-3 h-3"
                    style={{
                        color: 'var(--text-tertiary)', flexShrink: 0,
                        transform: open ? 'rotate(180deg)' : 'none',
                        transition: 'transform 0.18s cubic-bezier(0.22, 1, 0.36, 1)',
                    }}
                />
            )}
        </>
    );

    if (!interactive) {
        // A statement, not a control: no role, no tab stop, nothing to click.
        return (
            <span data-testid={testId} title={title || label} style={style}>{body}</span>
        );
    }

    return (
        <button
            type="button"
            onClick={onClick}
            aria-haspopup="dialog"
            aria-expanded={!!open}
            title={title || label}
            data-testid={testId}
            style={style}
        >{body}</button>
    );
}
