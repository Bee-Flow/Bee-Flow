/**
 * De onderdelen van de verticale tijdlijn — genummerd bolletje, verbindingslijn
 * en duurpil.
 *
 * Ze stonden als markup in `ToolsUsedTimeline`. Het spoorpaneel (A4 deel C)
 * toont dezelfde soort lijst — stappen onder elkaar, met de duur erbij — en
 * moet er ook hetzelfde uitzien: twee lijsten die naast elkaar in de bouwer
 * staan en net níet dezelfde bolletjes en pillen hebben, lezen als twee
 * verschillende soorten bewijs terwijl het één stroom is.
 *
 * Vandaar hier, letterlijk overgenomen, en door allebei gebruikt.
 *
 * `formatDurationMs` is de enige die iets beslist: onder een seconde in hele
 * milliseconden, daarboven op één decimaal. Die keuze zat in `ToolsUsedTimeline`
 * verstopt in een ternary, en de kop van het spoorpaneel ("· 1,8 s") moet
 * exact dezelfde afronding gebruiken — anders staat er 1,8 s boven een rij die
 * 1750 ms zegt.
 */

import React from 'react';

/**
 * `1750` → `'1.8s'`, `840` → `'840ms'`, alles wat geen getal is → null.
 *
 * Negatieve duren bestaan niet; een klok die achteruit liep is geen meting,
 * dus die komt er als null uit in plaats van als '-3ms'.
 */
export function formatDurationMs(ms) {
    if (!Number.isFinite(ms) || ms < 0) return null;
    return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Het genummerde bolletje links van een stap. */
export function StepBadge({ n, muted = false }) {
    return (
        <div className="flex-shrink-0 w-5.5 h-5.5 mt-0.5 z-10 relative">
            <div
                className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold"
                style={{
                    background: 'var(--bg-secondary)',
                    border: muted ? '1.5px dashed var(--border-subtle)' : '1.5px solid var(--border-subtle)',
                    color: muted ? 'var(--text-tertiary)' : 'var(--text-secondary)',
                }}
            >
                {n}
            </div>
        </div>
    );
}

/**
 * De verticale lijn achter de bolletjes. Hoort in een `relative` ouder en
 * alleen bij twee of meer stappen — één bolletje met een streep eraan suggereert
 * een stap die er niet is.
 */
export function TimelineRail({ show = true }) {
    if (!show) return null;
    return (
        <div
            className="absolute left-[11px] top-4 bottom-4 w-px"
            style={{ background: 'var(--border-subtle)' }}
            aria-hidden="true"
        />
    );
}

/** De duur rechts op een regel. Geen meting ⇒ geen pil. */
export function DurationPill({ ms, title }) {
    const label = formatDurationMs(ms);
    if (!label) return null;
    return (
        <span
            className="text-[10px] px-1.5 py-0.5 rounded"
            style={{ background: 'var(--bg-secondary)', color: 'var(--text-tertiary)' }}
            data-testid="duration-pill"
            title={title}
        >
            {label}
        </span>
    );
}
