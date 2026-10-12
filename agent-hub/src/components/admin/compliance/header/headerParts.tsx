/**
 * headerParts: the controls of the Compliance section header. ComplianceHeader
 * and header/registerSpecs compose every section's header from these four:
 *
 *   PrimaryButton    the one filled action, in PRIMARY_ACTION_STYLE
 *   SecondaryButton  a bordered action; its label folds below 1180px and
 *                    stays the button's aria-label and title. Without a
 *                    handler or a link it renders NOTHING, never a dead button
 *   InfoChip         quiet grey meta text (a legal reference, the last run),
 *                    no box, so it never reads as a button. Below 1180px only
 *                    the icon remains, as a focusable trigger of the shared
 *                    Tooltip carrying the full text
 *   ExportMenu       a primary "Export" button with a menu of download links,
 *                    or a disabled one that says why when downloads are off
 *
 * Folding. These sit inside StudioSectionHeader's `@container/objhead`, and
 * the fold classes are its literals (OBJHEAD_FOLD). On the phone the header's
 * action row sits OUTSIDE that container, so every label shows in full there.
 */
import { ChevronDown } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import React, { useId, useRef, useState } from 'react';
import type { ComponentType, ReactNode } from 'react';
import AnchoredMenuJs from '../../../shared/AnchoredMenu';
import { OBJHEAD_FOLD, PRIMARY_ACTION_STYLE } from '../../../shared/StudioSectionHeader';
import Tooltip from '../../../shared/Tooltip';

// A .jsx module whose `= null` defaults would type the props as null-only.
const AnchoredMenu = AnchoredMenuJs as unknown as ComponentType<Record<string, unknown>>;

export const HEADER_BUTTON = 'inline-flex items-center gap-1.5 h-8 px-3 rounded-[10px] text-[12px] whitespace-nowrap';
const SECONDARY = `${HEADER_BUTTON} font-medium border border-[var(--border-default)] bg-[var(--bg-card)] text-[var(--text-primary)] hover:bg-[var(--item-hover-bg)]`;
const PRIMARY = `${HEADER_BUTTON} font-semibold disabled:opacity-60 disabled:cursor-not-allowed aria-disabled:opacity-60 aria-disabled:cursor-not-allowed`;
const INFO = 'inline-flex items-center gap-1 text-[11px] text-[var(--text-tertiary)] min-w-0';
/** The inverse of OBJHEAD_FOLD.action: painted only once the header has folded. */
const FOLDED_ONLY = 'hidden @max-[1180px]/objhead:inline-flex';
const ICON = 'w-[13px] h-[13px] flex-shrink-0';

export interface PrimaryButtonProps {
    onClick?: () => void;
    disabled?: boolean;
    icon?: LucideIcon;
    children: ReactNode;
    title?: string;
    testId?: string;
}

export function PrimaryButton({ onClick, disabled, icon: Icon, children, title, testId = 'header-primary' }: PrimaryButtonProps) {
    return (
        <button type="button" onClick={onClick} disabled={disabled} title={title} data-testid={testId}
            className={PRIMARY} style={PRIMARY_ACTION_STYLE}>
            {Icon && <Icon className={ICON} aria-hidden="true" />}{children}
        </button>
    );
}

export interface SecondaryButtonProps {
    onClick?: (() => void) | null;
    href?: string | null;
    download?: boolean;
    icon?: LucideIcon;
    /** The visible label; it folds to the icon below 1180px. */
    children?: string;
    /** The accessible name of an icon-only button (defaults to the label). */
    ariaLabel?: string;
    testId?: string;
}

export function SecondaryButton({ onClick, href, download, icon: Icon, children, ariaLabel, testId = 'header-secondary' }: SecondaryButtonProps) {
    if (!href && !onClick) return null;
    const name = ariaLabel || children || undefined;
    const body = (
        <>
            {Icon && <Icon className={ICON} aria-hidden="true" />}
            {children && <span className={OBJHEAD_FOLD.action}>{children}</span>}
        </>
    );
    if (href) {
        return <a href={href} download={download} className={SECONDARY} data-testid={testId} aria-label={name} title={name}>{body}</a>;
    }
    return <button type="button" onClick={onClick || undefined} className={SECONDARY} data-testid={testId} aria-label={name} title={name}>{body}</button>;
}

export interface InfoChipProps {
    icon?: LucideIcon;
    /** The full text: shown wide, the tooltip and the trigger's name once folded. */
    children: string;
    /** A part that stays visible next to the icon once folded (the last run's time). */
    short?: string;
    title?: string;
    tone?: 'warning';
    testId?: string;
}

export function InfoChip({ icon: Icon, children, short, title, tone, testId = 'header-info' }: InfoChipProps) {
    const cls = tone === 'warning' ? `${INFO} text-[var(--warning-ink)]` : INFO;
    if (!Icon) return <span className={cls} data-testid={testId} data-tone={tone} title={title}>{children}</span>;
    return (
        <span className={cls} data-testid={testId} data-tone={tone} title={title}>
            <span className={`inline-flex items-center gap-1 min-w-0 ${OBJHEAD_FOLD.action}`}>
                <Icon className={ICON} aria-hidden="true" />
                <span className="truncate">{children}</span>
            </span>
            <span className={FOLDED_ONLY}>
                <Tooltip content={children} side="bottom">
                    <button type="button" aria-label={children} data-testid={`${testId}-trigger`}
                        className="inline-flex items-center gap-1 rounded-md cursor-default">
                        <Icon className={ICON} aria-hidden="true" />
                        {short && <span aria-hidden="true">{short}</span>}
                    </button>
                </Tooltip>
            </span>
        </span>
    );
}

export interface ExportItem {
    id: string;
    href: string;
    label: string;
    icon?: LucideIcon;
}

export interface ExportMenuProps {
    label: string;
    icon?: LucideIcon;
    /** The links that are live; none → the button is disabled and says why. */
    items: ExportItem[];
    /** One sentence above the links: what the downloads contain. */
    description?: string;
    disabledReason: string;
    testId?: string;
}

export function ExportMenu({ label, icon: Icon, items, description, disabledReason, testId = 'header-primary' }: ExportMenuProps) {
    const [open, setOpen] = useState(false);
    const anchorRef = useRef<HTMLButtonElement>(null);
    const reasonId = useId();
    const descId = useId();
    const face = (
        <>
            {Icon && <Icon className={ICON} aria-hidden="true" />}{label}
            <ChevronDown className={ICON} aria-hidden="true" />
        </>
    );
    if (!items.length) {
        // aria-disabled, not disabled: the button stays focusable, so the
        // keyboard reaches the explanation the tooltip shows on hover. It
        // opens to the left: the primary is the row's last control, and a
        // centred tooltip would run off the right edge of the window.
        return (
            <>
                <Tooltip content={disabledReason} side="left">
                    <span className="inline-flex">
                        <button type="button" aria-disabled="true" aria-describedby={reasonId} data-testid={testId}
                            className={PRIMARY} style={PRIMARY_ACTION_STYLE}>{face}</button>
                    </span>
                </Tooltip>
                <span id={reasonId} hidden>{disabledReason}</span>
            </>
        );
    }
    return (
        <>
            <button ref={anchorRef} type="button" aria-haspopup="menu" aria-expanded={open} data-testid={testId}
                onClick={() => setOpen(o => !o)} className={PRIMARY} style={PRIMARY_ACTION_STYLE}>{face}</button>
            <AnchoredMenu open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} align="right" width={300}
                role="menu" aria-label={label} aria-describedby={description ? descId : undefined} className="py-1">
                {description && (
                    <p id={descId} className="m-0 px-3 pt-1.5 pb-2 text-[11px] leading-4 text-[var(--text-tertiary)]">{description}</p>
                )}
                {items.map(({ id, href, label: text, icon: ItemIcon }) => (
                    <a key={id} role="menuitem" href={href} download onClick={() => setOpen(false)} data-testid={`header-export-${id}`}
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-[13px] text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)] focus:bg-[var(--bg-secondary)] focus:outline-none">
                        {ItemIcon && <ItemIcon className={ICON} aria-hidden="true" />}
                        <span className="min-w-0 truncate">{text}</span>
                    </a>
                ))}
            </AnchoredMenu>
        </>
    );
}
