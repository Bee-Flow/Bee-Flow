import React, { useId, useRef } from 'react';
import CmdTip from './CmdTip';
import useCmdTip from './useCmdTip';

/**
 * A single ribbon command button: icon + label. `big` renders the headline
 * vertical style (icon over label); otherwise a compact icon-left row that
 * packs into a RibbonCluster's 2-row grid.
 *
 * Glyph resolution: `icon` (a lucide component, sized internally) wins over
 * `glyph` (a pre-sized ReactNode — e.g. an <IntegrationLogo/>). The glyph prop
 * keeps this file free of feature imports.
 *
 * Explaining what a command DOES: pass `desc` and the button grows a styled
 * screen tip (CmdTip) showing the full label, the description and `tipFooter`.
 * Without `desc` it keeps the plain `title` attribute, so callers that never had
 * a description (App Studio's ComponentRibbon) are untouched.
 *
 * dnd-kit support (App Studio palette) is opt-in and inert otherwise:
 *   buttonRef  — forwarded to the <button>. Accepts BOTH ref shapes: an object
 *                ref or a CALLBACK ref (useDraggable's setNodeRef is one). The
 *                tip always anchors on the internal object ref — an earlier
 *                revision anchored on `buttonRef` directly, and a callback ref
 *                has no `.current`, so CmdTip could never position: with a
 *                `desc` set the tip stayed invisible AND the native title was
 *                already suppressed, leaving the button with no explanation
 *                at all.
 *   dragging   — dims the button while its drag preview is out
 *   grabbable  — grab cursor + touchAction:none (required for touch drag)
 *   ...rest    — spread LAST so dnd glue (onPointerDown) can never be
 *                clobbered; this component must not define its own
 *                onPointerDown. aria-describedby is the one exception: it is
 *                destructured out and COMPOSED with the screen tip's id, so
 *                the tip's description and dnd's drag instructions are both
 *                announced.
 */

const COMPACT = 'inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition disabled:opacity-50';
const BIG = 'flex flex-col items-center justify-center gap-0.5 px-3 py-1 rounded-md text-[11px] font-semibold transition disabled:opacity-50';
// The accent variant is the ribbon's ONE highlighted command. Tinted rather
// than merely coloured: bare accent text next to near-black neighbours read as
// washed out — users took the AI step for a disabled button.
const BIG_ACCENT = 'text-[var(--accent)] bg-[var(--accent)]/10 border border-[var(--accent)]/30 hover:bg-[var(--accent)]/20';
const BIG_PLAIN = 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]';
const GRAB = 'select-none cursor-grab active:cursor-grabbing';

function buttonClass({ big, accent, grabbable }) {
    const parts = big ? [BIG, accent ? BIG_ACCENT : BIG_PLAIN] : [COMPACT];
    if (grabbable) parts.push(GRAB);
    return parts.join(' ');
}

function buttonStyle({ dragging, grabbable }) {
    const style = {};
    if (dragging) style.opacity = 0.4;
    if (grabbable) style.touchAction = 'none';
    return style;
}

export default function CmdButton({
    icon: Icon = null,
    glyph = null,
    label,
    title,
    // The heading of the screen tip, when the button's own label is an
    // abbreviated form of the real name — an app shown as "Talk" inside a
    // cluster captioned NEXTCLOUD still has "Nextcloud Talk" as its name, and
    // the tip is where the full one belongs.
    tipTitle = null,
    desc = null,
    tipFooter = null,
    onClick,
    big = false,
    accent = false,
    disabled = false,
    dragging = false,
    grabbable = false,
    buttonRef = null,
    // Composed below, never spread raw: the tip's own id has to join whatever
    // the caller sends (dnd-kit's drag instructions), or a screen reader gets
    // one description and loses the other.
    'aria-describedby': describedBy = null,
    ...rest
}) {
    // The rich tip and the native tooltip are mutually exclusive: showing both
    // gives the user two overlapping explanations of the same button.
    const localRef = useRef(null);
    // The element lands in localRef ALWAYS (CmdTip needs a `.current` to
    // measure) and is forwarded to the caller's ref in whichever shape it has.
    const setRefs = (el) => {
        localRef.current = el;
        if (typeof buttonRef === 'function') buttonRef(el);
        else if (buttonRef) buttonRef.current = el;
    };
    const tipped = !!desc;
    const { open, hoverProps, dismiss } = useCmdTip(tipped);
    // The tip is role="tooltip" but a tooltip nobody points at is silent —
    // referencing it from the button is what makes the description announced
    // on keyboard focus (the tip opens on focus, so the id resolves).
    const tipId = useId();
    const tipShown = tipped && open && !disabled;

    const button = (
        <button
            type="button"
            ref={setRefs}
            disabled={disabled}
            title={tipped ? undefined : title}
            onClick={(e) => { dismiss?.(e); onClick?.(e); }}
            style={buttonStyle({ dragging, grabbable })}
            className={buttonClass({ big, accent, grabbable })}
            {...hoverProps}
            {...rest}
            aria-describedby={[describedBy, tipShown ? tipId : null].filter(Boolean).join(' ') || undefined}
        >
            {Icon ? <Icon size={big ? 18 : 14} /> : glyph}
            {/* 10rem, not 8: at 8rem the longest labels were clipped mid-word on
                the ribbon — "Check for personal d…" — and the clipped one was
                the privacy step, the thing the product is for. The tip carries
                the full name either way, but a label you cannot read is not a
                label. `big` is a lone headline command with room to spare. */}
            <span className={big ? undefined : 'truncate max-w-[10rem]'}>{label}</span>
        </button>
    );

    if (!tipped) return button;
    return (
        <>
            {button}
            <CmdTip id={tipId} anchorRef={localRef} open={open && !disabled} title={tipTitle || label} desc={desc} footer={tipFooter} />
        </>
    );
}
