import { AlertTriangle, MoreHorizontal, Plus } from 'lucide-react';
import React, { useRef } from 'react';
import AnchoredMenu from '../../../shared/AnchoredMenu';
import { kindIcon, kindTileStyle } from '../../../shared/kindColors';

/**
 * De kaartvorm van de tab "Kan gebruiken" (Agents-artboard 1a, A2 stap 2).
 *
 * Eén schil voor Kennis, Skills en straks Tools: kindtegel, titel, ondertitel,
 * "+ Koppelen" en een ⋯-menu; daaronder rijen. De schil tekent geen gedrag —
 * hij weet niet wat een kennisbank is — zodat de drie kaarten niet uit elkaar
 * kunnen groeien in vorm terwijl ze naast elkaar staan.
 *
 * De tegel komt uit `shared/kindColors`, dezelfde legenda als de Studio-rail:
 * een kennisbank is hier dezelfde kleur en hetzelfde glyph als in Studio, en
 * een skill ook. Dat is de hele reden dat die module bestaat.
 */
/**
 * Het glyph van de kindtegel. Losse functie om dezelfde reden als
 * `shared/StudioSectionHeader.renderGlyph`: `kindIcon()` geeft een STABIELE
 * module-referentie terug, maar de react-hooks-regel ziet een hoofdletter-
 * variabele die tijdens de render ontstaat en leest dat als een component die
 * per render opnieuw gemaakt wordt.
 */
function renderKindGlyph(Glyph, style) {
    if (!Glyph) return null;
    return <Glyph style={style} aria-hidden="true" />;
}

export default function CanUseCard({ kind, title, subtitle, action, menu, children, testId }) {
    const { tile, glyph } = kindTileStyle(kind, 28);
    const icon = kindIcon(kind);
    return (
        <section
            data-testid={testId}
            className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card,#fff)] overflow-hidden mb-6"
        >
            <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border-default)]">
                <span style={tile} aria-hidden="true">{renderKindGlyph(icon, glyph)}</span>
                <span className="min-w-0 flex-1">
                    <span className="block text-[14px] font-semibold text-[var(--text-primary)] truncate">{title}</span>
                    {subtitle && (
                        <span className="block text-[12px] text-[var(--text-tertiary)] truncate">{subtitle}</span>
                    )}
                </span>
                {action}
                {menu}
            </div>
            <div className="divide-y divide-[var(--border-default)]">{children}</div>
        </section>
    );
}

/** De "+ Koppelen"-knop van een kaart. */
export function LinkButton({ label, onClick, disabled = false, testId }) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            data-testid={testId}
            className="flex items-center gap-1.5 h-8 px-3 rounded-lg text-[13px] font-medium border border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50 transition flex-shrink-0"
        >
            <Plus size={14} aria-hidden="true" />
            {label}
        </button>
    );
}

/**
 * Het ⋯-menu van een kaart: een knop met een AnchoredMenu eraan.
 *
 * `AnchoredMenu` en niet een `absolute` paneeltje, om dezelfde reden als
 * BFSF-328: de tab scrollt in een eigen kolom, en een absoluut paneel wordt
 * daar afgeknipt zodra de kaart onderaan staat.
 */
export function CardMenu({ label, open, onToggle, onClose, children, testId }) {
    const anchorRef = useRef(null);
    return (
        <>
            <button
                ref={anchorRef}
                type="button"
                onClick={onToggle}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={label}
                title={label}
                data-testid={testId}
                className="flex items-center justify-center w-8 h-8 rounded-lg border border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)] transition flex-shrink-0"
            >
                <MoreHorizontal size={16} aria-hidden="true" />
            </button>
            <AnchoredMenu open={open} onClose={onClose} anchorRef={anchorRef} align="right" width={320}>
                <div className="p-3">{children}</div>
            </AnchoredMenu>
        </>
    );
}

/**
 * Eén rij: glyph, titel, en een ondertitel van losse feiten.
 *
 * `parts` is een LIJST, geen zin. Elk deel is op zichzelf vertaalbaar en de
 * scheiding is typografie ("·"), niet grammatica — een halve zin aan elkaar
 * plakken zou precies de grammatica-in-code opleveren die de i18n-conventies
 * verbieden. Een deel dat niemand kon meten staat er niet: de rij zwijgt
 * liever over een teller dan dat hij er een verzint.
 */
export function CanUseRow({ icon, title, parts = [], note = null, muted = false, testId }) {
    const shown = parts.filter(p => typeof p === 'string' && p);
    return (
        <div data-testid={testId} className="flex items-start gap-3 px-4 py-3">
            {icon && <span className="mt-0.5 flex-shrink-0 text-[var(--text-tertiary)]" aria-hidden="true">{icon}</span>}
            <div className="min-w-0 flex-1">
                <div className={`text-[13px] truncate ${muted ? 'text-[var(--text-secondary)] italic' : 'text-[var(--text-primary)]'}`}>
                    {title}
                </div>
                {shown.length > 0 && (
                    <div className="text-[12px] text-[var(--text-tertiary)]">{shown.join(' · ')}</div>
                )}
                {note}
            </div>
        </div>
    );
}

/**
 * "Dit kon ik niet lezen" — nooit stilte, nooit een lege lijst.
 *
 * Staat BOVEN de rijen en niet in de plaats ervan: wat we wél weten (dat er
 * drie kennisbanken gekoppeld zijn) blijft staan, en deze regel zegt welk deel
 * ontbreekt. `role="status"` want het is een mededeling over de toestand van
 * het scherm, niet over de inhoud van de agent.
 */
export function UnreadableNotice({ message, retryLabel, onRetry, testId }) {
    return (
        <div
            role="status"
            data-testid={testId}
            className="flex items-start gap-2 px-4 py-3 text-[12px]"
            style={{ background: 'color-mix(in srgb, var(--warning) 8%, transparent)' }}
        >
            <AlertTriangle size={14} aria-hidden="true" style={{ color: 'var(--warning)', flexShrink: 0, marginTop: 1 }} />
            <span className="flex-1 text-[var(--text-secondary)]">{message}</span>
            {onRetry && (
                <button
                    type="button"
                    onClick={onRetry}
                    className="px-2 py-0.5 rounded-md border border-[var(--border-default)] hover:bg-[var(--bg-secondary)] transition flex-shrink-0"
                >
                    {retryLabel}
                </button>
            )}
        </div>
    );
}

/** De rustige variant: gelezen, en er is echt niets. */
export function EmptyRow({ message, testId }) {
    return (
        <div data-testid={testId} className="px-4 py-4 text-[13px] text-[var(--text-tertiary)]">
            {message}
        </div>
    );
}
