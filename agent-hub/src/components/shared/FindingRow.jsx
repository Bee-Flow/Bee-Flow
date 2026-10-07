import React from 'react';
import { TONES } from './statusTone';

/**
 * ONE row for "this needs a person", wherever it is shown.
 *
 * The recipe is the builder's validation pill's, lifted out of it unchanged
 * (automation/Builder/FloatingValidationPill.jsx — this component IS the
 * `Record` that used to live there, and the pill now renders it): a tinted
 * card in the severity's colour, the machine `code` in 10px mono at the left
 * so a support answer can quote it, a bold `label` when the caller holds the
 * object's name apart from the sentence (the canvas does: the step's name),
 * the sentence itself, and the fix on its own quieter "→" line underneath.
 *
 * It lives in shared/ because the same row is now drawn on two very different
 * surfaces — a floating chip over the automation canvas, and the "Needs
 * attention" list on Studio's Start screen — and a finding that looks like one
 * thing in the builder and another thing on Home is two different products
 * telling you about the same broken button.
 *
 * Deliberately dumb: no i18n, no data shape of its own, no deep-link
 * knowledge. Each caller maps whatever it holds (a validator record with a
 * step id, a Finding with a targetRef) onto these props and hands over an
 * `onOpen` that knows where its own "show me" goes.
 *
 * `size="sm"` is the callout inside a 12px drawer (the Compliance registers):
 * text-xs with a snug line, and the text in the tone's INK rather than its
 * raw colour (raw amber as text on its own 5 % tint is under 3:1). The
 * border and the tint keep the raw tone. The default size is what the
 * builder pill and Studio Home have always drawn.
 */

/**
 * The severity's ink. 'info' has no token of its own — index.css defines
 * --success/--warning/--error and no --info — and a neutral ink is the honest
 * answer for advice: it must not read as a warning. Anything unrecognised
 * lands on --warning, which is what the pill did before this was shared.
 */
function severityTone(severity) {
    if (severity === 'error') return 'var(--error)';
    if (severity === 'info') return 'var(--text-tertiary)';
    return 'var(--warning)';
}

/** The text colour of a small row: the tone's ink (info: neutral ink). */
function severityInk(severity) {
    if (severity === 'error') return TONES.error.ink;
    if (severity === 'info') return TONES.neutral.ink;
    return TONES.warning.ink;
}

/** Size-dependent look: the class, the text colour and the data attribute. */
function rowLook(size, severity, tone) {
    if (size === 'sm') return { sizeClass: 'text-xs leading-snug', ink: severityInk(severity), dataSize: 'sm' };
    return { sizeClass: '', ink: tone, dataSize: undefined };
}

export default function FindingRow({
    code = null,
    severity = 'warning',
    label = null,
    message,
    hint = null,
    onOpen = null,
    openLabel = undefined,
    icon = null,
    size = 'md',
    testId = undefined,
}) {
    const tone = severityTone(severity);
    const look = rowLook(size, severity, tone);
    const clickable = typeof onOpen === 'function';
    // Every interactive attribute in one place: a row that opens something is
    // a button with a keyboard, and a row that opens nothing is plain text.
    const interactive = clickable ? {
        role: 'button',
        tabIndex: 0,
        onClick: () => onOpen(),
        onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } },
        title: openLabel,
    } : null;
    return (
        <div
            {...interactive}
            data-testid={testId}
            data-severity={severity}
            data-size={look.dataSize}
            className={`rounded px-2.5 py-1.5 ${look.sizeClass} ${clickable ? 'cursor-pointer hover:brightness-95' : ''}`.replace(/\s+/g, ' ').trim()}
            style={{ background: `color-mix(in srgb, ${tone} 5%, transparent)`, border: `1px solid color-mix(in srgb, ${tone} 20%, transparent)` }}
        >
            <div className="flex items-start gap-1.5" style={{ color: look.ink }}>
                {/* Optional leading glyph: on Studio Home a row can be about any
                    kind, and the kind's own tinted icon is how the list stays
                    readable across ten of them. The canvas has one kind (a
                    step) and passes none. */}
                {icon}
                {code && <span className="font-mono text-[10px] mt-px opacity-70 flex-shrink-0">{code}</span>}
                <span className="flex-1">
                    {label && <span className="font-semibold">{label}: </span>}
                    {message}
                </span>
            </div>
            {hint && (
                <div className="text-[10px] text-[var(--text-tertiary)] mt-0.5 leading-snug">→ {hint}</div>
            )}
        </div>
    );
}
