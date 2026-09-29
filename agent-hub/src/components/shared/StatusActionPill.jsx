import React from 'react';
import { normalizeStatus } from './statusOf';
import useTranslation from '../../hooks/useTranslation';

/**
 * StatusActionPill — a thing's status and its ONE next action as a single
 * split pill: `LIVE · Pause`, `DRAFT · Activate`, `OUTDATED · Republish`
 * (Studio Home artboard 1b "Gedeelde patronen"; Bee Flow Builder redesign,
 * Sep 2026, plan 0.3b). Every Studio kind's header paints its state with
 * this; the status word comes from `shared/statusOf.js`.
 *
 * The SHAPE is the artboard's: 32px tall, radius 10, one hairline divider,
 * the status dot on the left, the action on the right, the words folding
 * away as the header narrows. The FILL is not. Artboard 1b fills the pill
 * with ink (`background: var(--text-primary)`), which read as a black block
 * against a light chrome (user feedback 2026-09-03). So the pill speaks in
 * the THEME's own words instead:
 *
 *   - `live` / `published` wear the success tint — the green a finished
 *     step wears;
 *   - `stale` (published AND behind) wears --warning, because the audience
 *     is running something older than what is on screen, and its action
 *     defaults to "Republish";
 *   - `draft` / `paused` / `unknown` are neutral (`unknown` gets a hollow
 *     dot: the row could not say, and the pill will not guess);
 *   - the action that moves a thing forward (Activate, Publish, Republish)
 *     is the header's one primary action and wears the theme's accent with
 *     its paired foreground (--accent-primary-fg) — the recipe the Studio's
 *     filled buttons use, pinned by BuilderHeader.views.test.jsx. The
 *     action that quiets a live thing (Pause) stays plain. `action.primary`
 *     overrides the guess.
 *
 * Folding is decided by the header that hosts the pill: the status word
 * hides below 1440px of the named `@container`, the action word below
 * 1180px (BuilderHeader's `@container/bar` stages, which the App Studio
 * `edhead` header shares). Tailwind only emits a variant it can read as one
 * literal in the source, so a container name must be listed in
 * FOLD_CLASSES below — adopting the pill in a new header means adding its
 * name there (a name it does not know still renders, it just never folds).
 * `containerName={null}` switches folding off for a pill that sits in a
 * card or a list row.
 *
 * Props
 *   status         'live' | 'paused' | 'draft' | 'published' | 'stale' | 'unknown'
 *                  (anything else is painted as 'unknown')
 *   label          optional override for the status word — a caller with a
 *                  richer label ("Live · 3 groups") keeps it
 *   action         null | { label, icon, onClick, disabled, title, ariaLabel, primary }
 *                  `icon` is a lucide component or a ready element; with no
 *                  action the pill is the status half alone
 *   containerName  the `@container/<name>` the fold classes address ('bar')
 *   testId         data-testid on the pill ('status-pill')
 *   className      extra classes on the outer element
 */

/** Literal fold variants per container name — see the docblock. */
export const FOLD_CLASSES = Object.freeze({
    bar: Object.freeze({ status: '@max-[1440px]/bar:hidden', action: '@max-[1180px]/bar:hidden' }),
    edhead: Object.freeze({ status: '@max-[1440px]/edhead:hidden', action: '@max-[1180px]/edhead:hidden' }),
});

const NO_FOLD = Object.freeze({ status: '', action: '' });

function foldFor(containerName) {
    if (!containerName) return NO_FOLD;
    return FOLD_CLASSES[containerName]
        ?? { status: `@max-[1440px]/${containerName}:hidden`, action: `@max-[1180px]/${containerName}:hidden` };
}

/** Which theme token a status speaks in; null = neutral ink. */
const TONE = Object.freeze({
    live: 'success',
    published: 'success',
    stale: 'warning',
    paused: null,
    draft: null,
    unknown: null,
});

function stylesFor(status) {
    const tone = TONE[status];
    if (tone) {
        const v = `var(--${tone})`;
        return {
            tone,
            cell: { background: `color-mix(in srgb, ${v} 12%, transparent)`, color: v },
            dot: { background: v, boxShadow: `0 0 0 3px color-mix(in srgb, ${v} 25%, transparent)` },
        };
    }
    if (status === 'unknown') {
        // A hollow dot: nothing is claimed.
        return {
            tone: 'neutral',
            cell: { color: 'var(--text-secondary)' },
            dot: { background: 'transparent', boxShadow: 'inset 0 0 0 1.5px var(--text-tertiary)' },
        };
    }
    return {
        tone: 'neutral',
        cell: { color: 'var(--text-secondary)' },
        dot: { background: 'var(--text-tertiary)' },
    };
}

function statusWord(t, status) {
    switch (status) {
        case 'live': return t('studio.status.live', 'Live');
        case 'paused': return t('studio.status.paused', 'Paused');
        case 'draft': return t('studio.status.draft', 'Draft');
        case 'published': return t('studio.status.published', 'Published');
        case 'stale': return t('studio.status.stale', 'Outdated');
        default: return t('studio.status.unknown', 'Unknown');
    }
}

// The theme's primary recipe: accent + its paired foreground. Never a bare
// text-white on the accent (measured ~2.5:1 on the default accent), never
// the artboard's ink.
const ACCENT_RECIPE = Object.freeze({ background: 'var(--accent-primary)', color: 'var(--accent-primary-fg)' });
const PRIMARY_CLASS = 'flex items-center gap-1.5 px-3 transition disabled:opacity-50 hover:brightness-95';
const QUIET_CLASS = 'flex items-center gap-1.5 px-3 text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition disabled:opacity-50';

/**
 * What the action half renders. Republish is the only label the pill
 * supplies itself: `stale` is the one state the artboard's two-state
 * capsule cannot show, so its next step must not depend on every caller
 * remembering it. The forward action is primary unless the caller says
 * otherwise; on a live/published thing the action quiets it, so it is not.
 */
function planAction(action, status, t) {
    if (!action) return null;
    const label = action.label ?? (status === 'stale' ? t('studio.status.republish', 'Republish') : null);
    const primary = action.primary ?? !(status === 'live' || status === 'published');
    return {
        label,
        ariaLabel: action.ariaLabel ?? label ?? undefined,
        className: primary ? PRIMARY_CLASS : QUIET_CLASS,
        style: primary ? ACCENT_RECIPE : undefined,
    };
}

function renderIcon(icon) {
    if (!icon) return null;
    if (React.isValidElement(icon)) return icon;
    const Icon = icon;
    return <Icon size={14} aria-hidden="true" />;
}

export default function StatusActionPill({
    status: rawStatus,
    label = null,
    action = null,
    containerName = 'bar',
    testId = 'status-pill',
    className = '',
}) {
    const { t } = useTranslation();
    const status = normalizeStatus(rawStatus);
    const { tone, cell, dot } = stylesFor(status);
    const fold = foldFor(containerName);
    const plan = planAction(action, status, t);

    return (
        <div
            className={`inline-flex items-stretch h-8 rounded-[10px] overflow-hidden text-[13px] font-semibold border border-[var(--border-default)] bg-[var(--bg-secondary)] ${className}`.trim()}
            data-testid={testId}
            data-status={status}
            data-tone={tone}
        >
            <span
                className={`flex items-center gap-2 pl-3 ${plan ? 'pr-2.5' : 'pr-3'} text-[11px] uppercase tracking-wide`}
                style={cell}
            >
                <span className="h-2 w-2 rounded-full" style={dot} aria-hidden="true" />
                <span className={fold.status || undefined}>{label ?? statusWord(t, status)}</span>
            </span>
            {plan && (
                <>
                    <span aria-hidden="true" className="w-px self-stretch bg-[var(--border-default)]" />
                    <button
                        type="button"
                        onClick={action.onClick}
                        disabled={!!action.disabled}
                        title={action.title}
                        aria-label={plan.ariaLabel}
                        className={plan.className}
                        style={plan.style}
                    >
                        {renderIcon(action.icon)}
                        {plan.label != null && (
                            <span className={fold.action || undefined}>{plan.label}</span>
                        )}
                    </button>
                </>
            )}
        </div>
    );
}
