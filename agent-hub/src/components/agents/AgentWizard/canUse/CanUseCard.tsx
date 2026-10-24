import { AlertTriangle, MoreHorizontal, Plus } from 'lucide-react';
import React, { useRef } from 'react';
import type { ComponentType, CSSProperties, ReactNode } from 'react';
import AnchoredMenu from '../../../shared/AnchoredMenu';
import { kindIcon, kindTileStyle } from '../../../shared/kindColors';

/**
 * The card shape of the "Can use" tab (Agents artboard 1a, A2 step 2).
 *
 * One shell for Knowledge, Skills and later Tools: kind tile, title, subtitle,
 * "+ Link" and a ⋯ menu, with rows below. The shell draws no behaviour. It does not
 * know what a knowledge base is, so that the three cards cannot grow apart in shape
 * while they stand next to each other.
 *
 * The tile comes from `shared/kindColors`, the same legend as the Studio rail. A
 * knowledge base is the same colour and the same glyph here as in Studio, and a
 * skill is too. That is the whole reason that module exists.
 */
/**
 * The glyph of the kind tile. A separate function for the same reason as
 * `shared/StudioSectionHeader.renderGlyph`: `kindIcon()` returns a STABLE module
 * reference, but the react-hooks rule sees a capitalised variable that arises during
 * the render and reads it as a component that is created anew on every render.
 */
function renderKindGlyph(Glyph: ComponentType<{ style?: CSSProperties; 'aria-hidden'?: boolean | 'true' }> | null | undefined, style: CSSProperties) {
    if (!Glyph) return null;
    return <Glyph style={style} aria-hidden="true" />;
}

export interface CanUseCardProps {
    kind: string;
    title: ReactNode;
    subtitle?: ReactNode;
    action?: ReactNode;
    menu?: ReactNode;
    children?: ReactNode;
    testId?: string;
}

export default function CanUseCard({ kind, title, subtitle, action, menu, children, testId }: CanUseCardProps) {
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
export function LinkButton({ label, onClick, disabled = false, testId }: { label: ReactNode; onClick?: () => void; disabled?: boolean; testId?: string }) {
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
 * The ⋯ menu of a card: a button with an AnchoredMenu attached.
 *
 * `AnchoredMenu` and not an `absolute` panel, for the same reason as BFSF-328: the
 * tab scrolls in its own column, and an absolute panel is clipped there as soon as
 * the card is at the bottom.
 */
export function CardMenu({ label, open, onToggle, onClose, children, testId }: { label: string; open: boolean; onToggle: () => void; onClose: () => void; children?: ReactNode; testId?: string }) {
    const anchorRef = useRef<HTMLButtonElement>(null);
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
 * One row: glyph, title, and a subtitle of loose facts.
 *
 * `parts` is a LIST, not a sentence. Each part is translatable on its own, and the
 * separation is typography ("·"), not grammar. Gluing a half sentence together
 * would produce exactly the grammar-in-code that the i18n conventions forbid. A part
 * that nobody could measure does not appear: the row prefers to say nothing about a
 * counter rather than invent one.
 */
export function CanUseRow({ icon, title, parts = [], note = null, muted = false, testId }: { icon?: ReactNode; title: ReactNode; parts?: unknown[]; note?: ReactNode; muted?: boolean; testId?: string }) {
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
 * "I could not read this": never silence, never an empty list.
 *
 * Placed ABOVE the rows and not in their place. What we DO know (that three knowledge bases are
 * linked) stays, and this line says which part is missing. `role="status"` because it is a
 * message about the state of the screen, not about the content of the agent.
 */
export function UnreadableNotice({ message, retryLabel, onRetry, testId }: { message: ReactNode; retryLabel?: ReactNode; onRetry?: (() => void) | null; testId?: string }) {
    return (
        <div
            role="status"
            data-testid={testId}
            className="flex items-start gap-2 px-4 py-3 text-[12px] [background:color-mix(in_srgb,var(--warning)_8%,transparent)]"
        >
            <AlertTriangle size={14} aria-hidden="true" className="[color:var(--warning)] [flex-shrink:0] [margin-top:1px]" />
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
export function EmptyRow({ message, testId }: { message: ReactNode; testId?: string }) {
    return (
        <div data-testid={testId} className="px-4 py-4 text-[13px] text-[var(--text-tertiary)]">
            {message}
        </div>
    );
}
