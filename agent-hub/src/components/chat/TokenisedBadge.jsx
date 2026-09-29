/**
 * De amberen "Scan incomplete"-pil onder het gebruikersbericht: een geüpload
 * bestand was te groot of te traag om helemaal te controleren, en onder het
 * fail_open-beleid van de org ging het ongecontroleerde deel er ongeredigeerd
 * doorheen. Deze pil maakt die doorlaat ZICHTBAAR — nooit stil.
 *
 * ── C7: de blauwe "N items redacted"-pil staat hier niet meer ───────────────
 * Die pil was de TELLERVORM van de privacyclaim: een bewering over een aantal,
 * met de plaatsvervanger en de zin "the real values stay here" pas één klik
 * diep in de popover erachter. Wat er onder een bericht hoort te staan is de
 * regel zelf, mét de plaatsvervanger die er daadwerkelijk voor in de plaats
 * ging — en zonder geruststelling waar die plaatsvervanger onbekend is. Die
 * regel is `MessageItem/PrivacyLine.jsx` (meting in `privacyLine.js`), en het
 * enige call-site van deze component geeft sindsdien alleen nog `warnings`
 * mee. De pil hier weghouden is geen opruimwerk maar de bevinding: twee
 * componenten die dezelfde claim maken, met verschillende bewijslast, lopen
 * uit elkaar.
 *
 * ── Kleur ──────────────────────────────────────────────────────────────────
 * Geen enkele rgba() meer in dit bestand. De chip volgt het recept dat
 * index.css documenteert: 14% tint van het ruwe statustoken als vlak, het
 * -ink-token voor de woorden, 40% van het ruwe token voor de rand. De
 * hardgecodeerde amber (`rgb(180,83,9)`) was de lichte waarde: op de donkere
 * thema's zakte hij naar ~2,4:1 op zijn eigen chip.
 *
 * ── Layering (BFSF-303) ────────────────────────────────────────────────────
 * Het detailpaneel gaat door AnchoredMenu (portal naar <body>) in plaats van
 * een `absolute … z-50`-span. Twee losse fouten maakten samen de gemelde
 * "kapotte overlay":
 *
 *   1. Layering. Het paneel stond in de berichtenrij, en in de glasthema's
 *      draagt elke `[data-surface]` een backdrop-filter — waardoor elk bericht
 *      zijn eigen stacking context is. `z-50` is dan alleen lokaal, dus het
 *      paneel schilderde ONDER de volgende bubbels. Een portal is de enige
 *      uitweg; AnchoredMenu lost precies dit al op voor de node-config-menu's
 *      (BFSF-328) en klemt gratis binnen de viewport.
 *   2. Doorschijnendheid. Het paneel schilderde `var(--bg-card)`, in
 *      `glass`/`glass-dark` bewust een doorschijnende rgba(…, 0.55), dus de
 *      chattekst erachter kwam er dwars doorheen. Het paneel draagt nu
 *      `data-tokenised-popover`, en index.css geeft dat in de glasthema's een
 *      dicht tier-3-vlak met zware blur — dezelfde behandeling waarmee het
 *      profielmenu leesbaar blijft boven een wallpaper.
 */

import React, { useRef, useState } from 'react';
import { X, AlertTriangle } from 'lucide-react';
import AnchoredMenu from '../shared/AnchoredMenu';
import { interpolate } from '../../hooks/useTranslation';

/** Het chiprecept uit index.css: tint als vlak, -ink als tekst, 40% als rand. */
const WARN_TINT = 'color-mix(in srgb, var(--warning) 14%, transparent)';
const WARN_EDGE = 'color-mix(in srgb, var(--warning) 40%, transparent)';
const WARN_INK = 'var(--warning-ink, var(--warning))';

function warningLine(w, t) {
    if (w.reason === 'overflow') {
        return t('dlp.attachment_overflow_truncated', 'too large to fully check; the rest was left out');
    }
    if (w.reason === 'timeout') {
        return t('dlp.attachment_timeout_truncated', 'check ran out of time; the rest was left out');
    }
    return t('dlp.attachment_degraded_truncated', 'checking unavailable; the rest was left out');
}

/**
 * De reserve-`t`. Hij MOET interpoleren: de paginazin draagt een `{scanned}`
 * en een `{total}`, en een reserve die alleen zijn tweede argument teruggeeft
 * zet die placeholders letterlijk op het scherm. Een aanroeper die geen `t`
 * doorgeeft is daarmee niet ongeluidig kapot, alleen onvertaald.
 */
const FALLBACK_T = (_key, en, params) => interpolate(en, params);

export default function TokenisedBadge({ warnings = [], t = FALLBACK_T }) {
    const [open, setOpen] = useState(false);
    const warnRef = useRef(null);

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
                                    <span style={{ color: 'var(--text-secondary)' }}>
                                        {' — '}{t('dlp.attachment_scanned_partial', 'Scanned {scanned} of {total} pages', { scanned, total })}
                                    </span>
                                )}
                                <div style={{ color: 'var(--text-secondary)' }}>⚠️ {warningLine(w, t)}</div>
                            </li>
                        );
                    })}
                </ul>
            </AnchoredMenu>
        </span>
    );
}
