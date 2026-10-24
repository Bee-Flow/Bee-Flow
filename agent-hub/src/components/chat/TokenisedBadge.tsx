/**
 * The amber "Scan incomplete" pill under the user message: an uploaded file was
 * too large or too slow to check completely, and under the org's fail_open policy
 * the unchecked part went through unredacted. This pill makes that pass-through
 * VISIBLE, never silently.
 *
 * ── C7: the blue "N items redacted" pill is not here any more ───────────────
 * That pill was the COUNTER FORM of the privacy claim: a claim about a number,
 * with the stand-in and the sentence "the real values stay here" only one click
 * deep in the popover behind it. What belongs under a message is the line itself,
 * with the stand-in that actually went in its place, and without reassurance where
 * that stand-in is unknown. That line is `MessageItem/PrivacyLine.jsx` (the
 * measurement is in `privacyLine.js`), and the only call site of this component
 * now passes nothing but `warnings`. Keeping the pill away here is not tidying up,
 * it is the finding itself: two components making the same claim with different
 * evidence drift apart.
 *
 * ── Color ──────────────────────────────────────────────────────────────────
 * No rgba() any more in this file. The chip follows the recipe that index.css
 * documents: a 14% tint of the raw status token as the surface, the -ink token for
 * the words, and 40% of the raw token for the border. The hard-coded amber
 * (`rgb(180,83,9)`) was the light value. On the dark themes it dropped to about
 * 2.4:1 on its own chip.
 *
 * ── Layering (BFSF-303) ────────────────────────────────────────────────────
 * The detail panel goes through AnchoredMenu (a portal to <body>) instead of an
 * `absolute … z-50` span. Two separate faults together made the reported "broken
 * overlay":
 *
 *   1. Layering. The panel stood in the message row. In the glass themes every
 *      `[data-surface]` carries a backdrop-filter, so every message is its own
 *      stacking context. `z-50` was then only local, and the panel painted UNDER
 *      the next bubbles. A portal is the only way out. AnchoredMenu already solves
 *      exactly this for the node-config menus (BFSF-328) and clamps to the viewport
 *      for free.
 *   2. Translucency. The panel painted `var(--bg-card)`, which in `glass` and
 *      `glass-dark` is deliberately a translucent rgba(…, 0.55), so the chat text
 *      behind it came straight through. The panel now carries
 *      `data-tokenised-popover`, and index.css gives that, in the glass themes, an
 *      opaque tier-3 surface with heavy blur. This is the same treatment that keeps
 *      the profile menu legible over a wallpaper.
 */

import { X, AlertTriangle } from 'lucide-react';
import { useRef, useState } from 'react';
import { interpolate, type TranslateParams } from '../../hooks/useTranslation';
import AnchoredMenu from '../shared/AnchoredMenu';

/** Het chiprecept uit index.css: tint als vlak, -ink als tekst, 40% als rand. */
const WARN_TINT = 'color-mix(in srgb, var(--warning) 14%, transparent)';
const WARN_EDGE = 'color-mix(in srgb, var(--warning) 40%, transparent)';
const WARN_INK = 'var(--warning-ink, var(--warning))';

type BadgeT = (key: string, en: string, params?: string | TranslateParams) => string;

function warningLine(w: { filename?: string; reason?: string; scannedPages?: number; totalPages?: number }, t: BadgeT) {
    if (w.reason === 'overflow') {
        return t('dlp.attachment_overflow_truncated', 'too large to fully check; the rest was left out');
    }
    if (w.reason === 'timeout') {
        return t('dlp.attachment_timeout_truncated', 'check ran out of time; the rest was left out');
    }
    return t('dlp.attachment_degraded_truncated', 'checking unavailable; the rest was left out');
}

/**
 * The fallback `t`. It MUST interpolate. The page sentence carries a `{scanned}`
 * and a `{total}`, and a fallback that returns only its second argument puts those
 * placeholders literally on the screen. A caller that does not pass a `t` is thereby
 * not silently broken, only untranslated.
 */
const FALLBACK_T = (_key: string, en: string, params?: string | TranslateParams) => interpolate(en, params);

interface TokenisedBadgeProps {
    warnings?: { filename?: string; reason?: string; scannedPages?: number; totalPages?: number }[];
    t?: BadgeT;
}

export default function TokenisedBadge({ warnings = [], t = FALLBACK_T }: TokenisedBadgeProps) {
    const [open, setOpen] = useState(false);
    const warnRef = useRef<HTMLButtonElement>(null);

    const hasWarnings = Array.isArray(warnings) && warnings.length > 0;
    if (!hasWarnings) return null;

    const close = () => setOpen(false);

    return (
        <span className="relative inline-flex items-center gap-1.5">
            <button
                ref={warnRef}
                type="button"
                onClick={() => setOpen(o => !o)}
                data-testid="scan-incomplete-pill"
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium transition-colors"
                style={{ background: WARN_TINT, color: WARN_INK, border: `1px solid ${WARN_EDGE}` }}
                title={t('dlp.badge_scan_incomplete_tooltip', 'Some uploaded content could not be scanned and was sent to the AI unredacted.')}
            >
                <AlertTriangle className="w-2.5 h-2.5" aria-hidden="true" />
                <span>{t('dlp.badge_scan_incomplete', 'Scan incomplete')}</span>
            </button>

            <AnchoredMenu
                open={open}
                onClose={close}
                anchorRef={warnRef}
                align="right"
                width={288}
                role="tooltip"
                data-tokenised-popover="warn"
                data-testid="tokenised-badge-warn-popover"
                className="p-3 text-xs leading-relaxed"
                style={{ background: 'var(--bg-card)', borderColor: WARN_EDGE, color: 'var(--text-primary)' }}
            >
                <div className="flex items-start justify-between mb-1.5">
                    <span className="font-semibold" style={{ color: WARN_INK }}>
                        {t('dlp.badge_scan_incomplete', 'Scan incomplete')}
                    </span>
                    <button onClick={close} className="p-0.5 rounded hover:bg-[var(--bg-tertiary)]" aria-label={t('common.close', 'Close')}>
                        <X className="w-3 h-3" />
                    </button>
                </div>
                <ul className="space-y-1.5">
                    {warnings.map((w, i) => {
                        const scanned = Number.isFinite(w.scannedPages) ? w.scannedPages : null;
                        const total = Number.isFinite(w.totalPages) ? w.totalPages : null;
                        return (
                            <li key={(w.filename || 'file') + i}>
                                <span className="font-medium">{w.filename || t('dlp.attachment_unnamed', 'attachment')}</span>
                                {(scanned != null && total != null) && (
                                    <span className="text-[var(--text-secondary)]">
                                        {' — '}{t('dlp.attachment_scanned_partial', 'Scanned {scanned} of {total} pages', { scanned, total })}
                                    </span>
                                )}
                                <div className="text-[var(--text-secondary)]">⚠️ {warningLine(w, t)}</div>
                            </li>
                        );
                    })}
                </ul>
            </AnchoredMenu>
        </span>
    );
}
