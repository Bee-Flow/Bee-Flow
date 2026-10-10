// The small Studio recipes the workspace repeats: buttons, cards, notice
// strips, the member avatar. Tokens only (`var(--…)` classes), so every theme
// — light, paper, sepia, the glass pair — paints them without `dark:` rules.

import { ChevronDown, Loader2, X } from 'lucide-react';
import React from 'react';
import useTranslation from '../../../hooks/useTranslation';
import { API_BASE } from '../../../utils/helpers';
import { hueOf, initialsOf } from './projectVisuals';

export const INPUT_CLASS =
    'w-full px-3 py-2 rounded-lg text-sm border border-[var(--border-default)] bg-[var(--bg-primary)] '
    + 'text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus-visible:outline focus-visible:outline-2 '
    + 'focus-visible:outline-offset-1 focus-visible:outline-[var(--accent-primary)] disabled:opacity-60';

export const SELECT_CLASS =
    'h-8 px-2 rounded-lg text-[13px] border border-[var(--border-default)] bg-[var(--bg-primary)] '
    + 'text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)] disabled:opacity-60';

const PRIMARY_CLASS =
    'inline-flex items-center justify-center gap-1.5 h-8 px-3 rounded-[10px] text-xs font-semibold whitespace-nowrap '
    + 'bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] hover:bg-[var(--accent-primary-hover)] transition-colors '
    + 'disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-primary)]';

const SECONDARY_CLASS =
    'inline-flex items-center justify-center gap-1.5 h-8 px-3 rounded-lg text-[13px] whitespace-nowrap border border-[var(--border-default)] '
    + 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--item-hover-bg)] transition-colors '
    + 'disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)]';

const GHOST_CLASS =
    'inline-flex items-center gap-1.5 px-1.5 py-1 rounded-lg text-[12px] text-[var(--text-tertiary)] '
    + 'hover:text-[var(--text-primary)] hover:bg-[var(--item-hover-bg)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

type ButtonIcon = React.ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' }>;
type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
    busy?: boolean;
    /** Leading lucide glyph, 14px. */
    icon?: ButtonIcon;
    /** data-testid shorthand. */
    testId?: string;
};

function withBusy(busy: boolean | undefined, children: React.ReactNode, Icon?: ButtonIcon) {
    return (
        <>
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />}
            {!busy && Icon && <Icon className="w-3.5 h-3.5" aria-hidden="true" />}
            {children}
        </>
    );
}

/** The theme's filled accent button — never an ink fill (Studio rule). */
export function PrimaryButton({ busy, icon, testId, className = '', children, type = 'button', disabled, ...rest }: ButtonProps) {
    return (
        <button type={type} disabled={disabled || busy} data-testid={testId} className={`${PRIMARY_CLASS} ${className}`.trim()} {...rest}>
            {withBusy(busy, children, icon)}
        </button>
    );
}

export function SecondaryButton({ busy, icon, testId, className = '', children, type = 'button', disabled, ...rest }: ButtonProps) {
    return (
        <button type={type} disabled={disabled || busy} data-testid={testId} className={`${SECONDARY_CLASS} ${className}`.trim()} {...rest}>
            {withBusy(busy, children, icon)}
        </button>
    );
}

export function GhostButton({ icon: Icon, testId, className = '', children, type = 'button', ...rest }: ButtonProps) {
    return (
        <button type={type} data-testid={testId} className={`${GHOST_CLASS} ${className}`.trim()} {...rest}>
            {Icon && <Icon className="w-3.5 h-3.5" aria-hidden="true" />}
            {children}
        </button>
    );
}

/** A small icon-only "take it out" button; the label is the accessible name. */
export function RemoveButton({ label, onClick, disabled = false }: { label: string; onClick: () => void; disabled?: boolean }) {
    return (
        <button
            type="button"
            aria-label={label}
            title={label}
            onClick={(e) => { e.stopPropagation(); onClick(); }}
            onKeyDown={(e) => e.stopPropagation()}
            disabled={disabled}
            className="grid place-items-center w-7 h-7 rounded-lg text-[var(--text-tertiary)] hover:text-[var(--error)] hover:bg-[var(--item-hover-bg)] disabled:opacity-50 transition-colors"
        >
            <X className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
    );
}

/** A panel card. `as="h3"` is the card inside a tab (roomier, with a description). */
export function Card({ title, description, action, children, className = '', testId, as = 'h2' }: {
    title?: React.ReactNode;
    description?: React.ReactNode;
    action?: React.ReactNode;
    children: React.ReactNode;
    className?: string;
    testId?: string;
    /** 'h2' (default, page card) or 'h3' (card inside a tab). */
    as?: 'h2' | 'h3';
}) {
    const Heading = as;
    const inTab = as === 'h3';
    return (
        <section
            className={`rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] ${inTab ? 'px-4 py-3.5' : 'px-3.5 py-3'} ${className}`.trim()}
            aria-label={inTab && typeof title === 'string' ? title : undefined}
            data-testid={testId}
        >
            {(title || action) && (
                <div className={`flex ${inTab ? 'flex-wrap items-start mb-3' : 'items-center justify-between mb-2'} gap-2`}>
                    <div className="flex-1 min-w-0">
                        {title && <Heading className="text-[13px] font-semibold text-[var(--text-primary)] m-0">{title}</Heading>}
                        {description && <p className="mt-0.5 text-[12px] text-[var(--text-tertiary)]">{description}</p>}
                    </div>
                    {action && <div className="flex flex-wrap items-center gap-2">{action}</div>}
                </div>
            )}
            {children}
        </section>
    );
}

/** The 11px uppercase heading of a section on a page. */
export function SectionLabel({ children, id }: { children: React.ReactNode; id?: string }) {
    return (
        <h2 id={id} className="text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--text-tertiary)] m-0">
            {children}
        </h2>
    );
}

export type NoticeTone = 'info' | 'warning' | 'error' | 'success';

const TONE_TEXT: Record<NoticeTone, string> = {
    info: 'text-[var(--info)]',
    warning: 'text-[var(--warning)]',
    error: 'text-[var(--error)]',
    success: 'text-[var(--success)]',
};

/** A notice strip: the icon carries the tone, the text stays readable ink. */
export function Notice({ tone = 'info', icon: Icon, children, action, testId, role }: {
    tone?: NoticeTone;
    icon?: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' }>;
    children: React.ReactNode;
    action?: React.ReactNode;
    testId?: string;
    role?: 'alert' | 'status';
}) {
    return (
        <div
            role={role}
            data-testid={testId}
            className="flex items-start gap-2 px-3 py-2.5 rounded-lg text-sm bg-[var(--bg-secondary)] text-[var(--text-secondary)]"
        >
            {Icon && <Icon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${TONE_TEXT[tone]}`} aria-hidden="true" />}
            <div className="flex-1 min-w-0">{children}</div>
            {action && <div className="flex-shrink-0">{action}</div>}
        </div>
    );
}

/** An inline error line under a form or a list. */
export function ErrorText({ children, testId }: { children: React.ReactNode; testId?: string }) {
    if (!children) return null;
    return (
        <p role="alert" data-testid={testId} className="text-xs text-[var(--error-ink)] m-0">
            {children}
        </p>
    );
}

/** The spinner row a section shows while it loads; `centered` fills the pane with the spinner alone. */
export function LoadingRow({ label, centered = false }: { label: string; centered?: boolean }) {
    if (centered) {
        return (
            <div className="flex h-full items-center justify-center py-12" role="status" aria-label={label}>
                <span className="w-6 h-6 rounded-full border-2 border-[var(--border-default)] border-t-[var(--accent-primary)] animate-spin" aria-hidden="true" />
            </div>
        );
    }
    return (
        <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-[var(--text-tertiary)]" role="status">
            <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
            <span>{label}</span>
        </div>
    );
}

/** A quiet sentence for members who can read but not change the content. */
export function ReadOnlyNote({ children }: { children: React.ReactNode }) {
    return <p className="text-[12px] text-[var(--text-tertiary)]">{children}</p>;
}

/**
 * The note for a reader who cannot change the content. In an archived project
 * the reason is the archive, whatever the role: "ask the owner for editor
 * access" would send them after something that would not help.
 */
export function ViewerNote({ archived, children }: { archived: boolean; children: React.ReactNode }) {
    const { t } = useTranslation();
    return (
        <ReadOnlyNote>
            {archived ? t('project_home.archived.read_only', 'This project is archived and read-only. Restore it to change anything.') : children}
        </ReadOnlyNote>
    );
}

/** The scrolling column every list view sits in; its first child is the fixed header. */
export function WorkspaceColumn({ children, testId }: { children: React.ReactNode; testId?: string }) {
    const [header, ...body] = React.Children.toArray(children);
    return (
        <div className="h-full flex flex-col min-h-0" data-testid={testId}>
            {header}
            <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
                <div className="max-w-6xl mx-auto px-4 sm:px-6 py-5 space-y-4">{body}</div>
            </div>
        </div>
    );
}

/** A round member avatar with initials, and an optional presence dot. */
export function Avatar({ name, size = 'md', online = false, onlineLabel, className = '', picture, color }: {
    name?: string | null;
    /** The person's own avatar; initials when absent. */
    picture?: { type: 'emoji' | 'image' | 'url'; value: string } | null;
    /** The person's colour in this project; without one the colour comes from the name. */
    color?: string | null;
    size?: 'sm' | 'md';
    online?: boolean;
    onlineLabel?: string;
    className?: string;
}) {
    const box = size === 'sm' ? 'w-6 h-6 text-[10px]' : 'w-8 h-8 text-[11px]';
    // Without a picture a person gets a colour of their own, the same one everywhere, instead of a grey disc.
    const hue = hueOf(name);
    const tint = !picture && name
        ? (color
            ? { background: `color-mix(in srgb, ${color} 20%, transparent)`, color: `color-mix(in srgb, ${color} 72%, var(--text-primary))` }
            : { background: `hsl(${hue} 70% 50% / 0.18)`, color: `hsl(${hue} 55% 42%)` })
        : undefined;
    return (
        <span
            className={`relative inline-grid place-items-center rounded-full flex-shrink-0 font-semibold ${tint ? '' : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]'} ring-2 ring-[var(--bg-secondary)] ${box} ${className}`.trim()}
            style={tint}
            title={name || undefined}
        >
            {picture && picture.type !== 'emoji'
                ? <img src={picture.value.startsWith('/') ? `${API_BASE}${picture.value}` : picture.value} alt="" loading="lazy" className="w-full h-full rounded-full object-cover" />
                : <span aria-hidden="true">{picture?.type === 'emoji' ? picture.value : initialsOf(name)}</span>}
            {online && (
                <span
                    className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-[var(--success)] ring-2 ring-[var(--bg-secondary)]"
                    role="img"
                    aria-label={onlineLabel}
                />
            )}
        </span>
    );
}

/**
 * Who has this item open right now: a small avatar stack, `max` faces and a
 * "+n". `people` maps ids to names (a missing one still shows a neutral face).
 */
export function ViewerStack({ ids, people, max = 3, label }: {
    ids: string[];
    people: Record<string, { name?: string | null } | undefined>;
    max?: number;
    /** The tooltip for one name: "{name} is viewing this". */
    label: (name: string) => string;
}) {
    if (ids.length === 0) return null;
    const shown = ids.slice(0, max);
    const extra = ids.length - shown.length;
    const names = ids.map((id) => people[id]?.name || '');
    return (
        <span className="inline-flex items-center -space-x-1.5" data-testid="viewer-stack" title={names.filter(Boolean).map(label).join('\n') || undefined}>
            {shown.map((id, i) => <Avatar key={id} size="sm" name={names[i]} />)}
            {extra > 0 && (
                <span className="relative inline-grid place-items-center w-6 h-6 rounded-full bg-[var(--bg-tertiary)] text-[10px] font-semibold tabular-nums text-[var(--text-secondary)] ring-2 ring-[var(--bg-secondary)]" data-testid="viewer-stack-more">
                    +{extra}
                </span>
            )}
        </span>
    );
}

/** A character counter that turns to the warning tone near the cap. */
export function CharCount({ value, max, id }: { value: string; max: number; id?: string }) {
    const near = value.length > max * 0.9;
    return (
        <span id={id} className={`text-[11px] tabular-nums ${near ? 'text-[var(--warning-ink)]' : 'text-[var(--text-tertiary)]'}`}>
            {value.length}/{max}
        </span>
    );
}

type SelectFieldProps = Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'size'> & {
    size?: 'sm' | 'md'; className?: string;
    /** `bare` drops the bordered look for borderless row controls that bring their own `className`. */
    bare?: boolean;
    wrapperClassName?: string;
};

/** A styled native select: keyboard- and screen-reader-complete, one look. `size="sm"` is the 28px row control. */
export const SelectField = React.forwardRef<HTMLSelectElement, SelectFieldProps>(function SelectField(
    { size = 'md', className = '', bare = false, wrapperClassName = 'relative inline-block', children, ...rest }, ref,
) {
    const own = `${bare ? '' : SELECT_CLASS}${!bare && size === 'sm' ? ' !h-7 text-xs' : ''} appearance-none pr-7`;
    return (
        <span className={wrapperClassName}>
            <select ref={ref} className={`${own} ${className}`.trim()} {...rest}>{children}</select>
            <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-tertiary)]" aria-hidden="true" />
        </span>
    );
});

const SKELETON_BAR = 'bg-[var(--bg-tertiary)] animate-pulse motion-reduce:animate-none';
const SKELETON_VARIANT = {
    rows: 'h-9 rounded-lg',
    cards: 'h-24 rounded-xl',
    lines: 'h-3 rounded w-[80%]',
} as const;

/** Placeholder bars while a list loads: `rows` grey bars, announced once as `label`. */
export function Skeleton({ rows = 3, label, variant = 'rows', className = '', barClassName = '', testId }: {
    rows?: number; label: string; variant?: 'rows' | 'cards' | 'lines'; className?: string; barClassName?: string; testId?: string;
}) {
    return (
        <div role="status" aria-label={label} data-testid={testId} className={className || 'space-y-2'}>
            {Array.from({ length: rows }, (_, i) => (
                <div key={i} aria-hidden="true" className={`${SKELETON_VARIANT[variant]} ${SKELETON_BAR} ${barClassName}`.trim()} />
            ))}
        </div>
    );
}
