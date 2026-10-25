import type { AriaAttributes, ButtonHTMLAttributes, ChangeEvent, CSSProperties, InputHTMLAttributes, ReactNode, Ref, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cloneElement, createElement as h, isValidElement, useId } from 'react';
import type { TranslateFn } from '../../../../../hooks/useTranslation';
import type { SideDrawerMode } from '../../../../shared/SideDrawer';
import { PRIMARY_ACTION_STYLE } from '../../../../shared/StudioSectionHeader';
import type { Tone } from '../../../../shared/statusTone';
import { TONES } from '../../../../shared/statusTone';
import type { DateLike } from '../../shared/formatDates';
import { formatDay, formatDayTime } from '../../shared/formatDates';
import type { OrgUser } from '../accessAuditLabels';

/**
 * auditForms — the vocabulary and the form atoms the four ISMS-process tabs
 * (audits · reviews · nonconformities · objectives) share, and that the other
 * register pages of the redesign borrow (policies, training, connectors,
 * ROPA, DPIA, settings all draw the same 12px inputs).
 *
 * Status tables are `{ tone, key, en }`: the tone is a statusTone pair
 * (border = raw, text = ink — never a fill), the key/en pair is the existing
 * compliance.* label. Read a label through `labelOf(t, table, value)` so an
 * unknown value renders its raw word rather than nothing.
 *
 * This is a `.ts` module (no JSX), so the atoms are written with `createElement`.
 */

/** One row of a status table: the tone (when it has one) and the compliance.* label. */
interface StatusEntry {
    tone?: Tone;
    key: string;
    en: string;
}

/** A status table as `labelOf` / `toneOf` read it: any value may be missing from it. */
export type StatusTable = Readonly<Record<string, Readonly<StatusEntry> | undefined>>;

export interface SelectOption {
    value: string | number;
    label: ReactNode;
}

type UserId = string | number;

export const AUDIT_STATUS = Object.freeze({
    planned: Object.freeze({ tone: 'neutral', key: 'compliance.audit_status_planned', en: 'Planned' }),
    in_progress: Object.freeze({ tone: 'warning', key: 'compliance.audit_status_in_progress', en: 'In progress' }),
    closed: Object.freeze({ tone: 'success', key: 'compliance.audit_status_closed', en: 'Closed' }),
});

export const FINDING_SEVERITY = Object.freeze({
    observation: Object.freeze({ tone: 'neutral', key: 'compliance.audit_sev_observation', en: 'Observation' }),
    minor: Object.freeze({ tone: 'warning', key: 'compliance.audit_sev_minor', en: 'Minor' }),
    major: Object.freeze({ tone: 'error', key: 'compliance.audit_sev_major', en: 'Major' }),
});

export const NC_STATUS = Object.freeze({
    open: Object.freeze({ tone: 'error', key: 'compliance.nc_status_open', en: 'Open' }),
    corrective_action: Object.freeze({ tone: 'warning', key: 'compliance.nc_status_corrective_action', en: 'Corrective action' }),
    effectiveness_review: Object.freeze({ tone: 'neutral', key: 'compliance.nc_status_effectiveness_review', en: 'Effectiveness review' }),
    closed: Object.freeze({ tone: 'success', key: 'compliance.nc_status_closed', en: 'Closed' }),
});

export const NC_SEVERITY = Object.freeze({
    minor: Object.freeze({ tone: 'warning', key: 'compliance.nc_sev_minor', en: 'Minor' }),
    major: Object.freeze({ tone: 'error', key: 'compliance.nc_sev_major', en: 'Major' }),
});

export const NC_SOURCE = Object.freeze({
    internal_audit: Object.freeze({ key: 'compliance.nc_source_internal_audit', en: 'Internal audit' }),
    management_review: Object.freeze({ key: 'compliance.nc_source_management_review', en: 'Management review' }),
    incident: Object.freeze({ key: 'compliance.nc_source_incident', en: 'Incident' }),
    check: Object.freeze({ key: 'compliance.nc_source_check', en: 'Automated check' }),
    manual: Object.freeze({ key: 'compliance.nc_source_manual', en: 'Manual' }),
});

export const OBJ_STATUS = Object.freeze({
    active: Object.freeze({ tone: 'neutral', key: 'compliance.obj_status_active', en: 'Active' }),
    achieved: Object.freeze({ tone: 'success', key: 'compliance.obj_status_achieved', en: 'Achieved' }),
    dropped: Object.freeze({ tone: 'neutral', key: 'compliance.obj_status_dropped', en: 'Dropped' }),
});

/** Label of `value` in a status table — falls back to the raw word, never to nothing. */
export function labelOf(t: TranslateFn, table: StatusTable, value?: string | null): string {
    const entry = value == null ? undefined : table[value];
    if (!entry) return value ? String(value).replace(/_/g, ' ') : '—';
    return t(entry.key, entry.en);
}

export function toneOf(table: StatusTable, value?: string | null, fallback: Tone = 'neutral'): Tone {
    return (value == null ? undefined : table[value])?.tone || fallback;
}

/** Display name of an org user by id — the id itself when the roster does not know them. */
export function userName(orgUsers?: OrgUser[] | null, id?: UserId | null): UserId | null {
    if (!id) return null;
    const u = (Array.isArray(orgUsers) ? orgUsers : []).find(x => String(x.id) === String(id));
    return u ? (u.displayName || u.email || u.id) : id;
}

/**
 * "19 Aug" / "3 Mar 2025" (formatDates.formatDay), '—' for no date. `locale`
 * is the app's language (useTranslation's resolvedLocale), never the
 * browser's: a Dutch screen in an English browser writes "19 aug".
 */
export function fmtDate(value?: unknown, locale?: string): string {
    return formatDay(value, locale) || '—';
}

/** "19 Aug 20:38", 24-hour (formatDates.formatDayTime), '—' for no date. */
export function fmtStamp(value?: DateLike, locale?: string): string {
    return formatDayTime(value, locale) || '—';
}

/** `YYYY-MM-DD` for a date input — '' when there is no date. */
export function dateInputValue(value?: DateLike): string {
    return value ? String(value).slice(0, 10) : '';
}

export function isOverdue(dueAt?: DateLike, { closed = false, now = Date.now() }: { closed?: boolean; now?: number } = {}): boolean {
    if (!dueAt || closed) return false;
    const ms = new Date(dueAt).getTime();
    return !Number.isNaN(ms) && ms < now;
}

/** A user option label: name — e-mail (the roster endpoint decides what it hands out). */
function userOptionLabel(u?: OrgUser | null): string {
    if (!u) return '';
    if (u.displayName) return u.email ? `${u.displayName} — ${u.email}` : u.displayName;
    return u.email || String(u.id);
}

/* ───────────────────────── form atoms ───────────────────────── */

export const INPUT_CLASS = 'w-full rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)] px-2.5 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--text-secondary)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]';
export const LABEL_CLASS = 'text-[10px] uppercase tracking-[.08em] font-semibold text-[var(--text-tertiary)]';

export interface FieldProps {
    label?: ReactNode;
    hint?: ReactNode;
    children?: ReactNode;
    className?: string;
    testId?: string;
}

/**
 * A labelled control. `hint` is helper text UNDER the control (not part of
 * the uppercase label), tied to it with aria-describedby so a screen reader
 * reads it after the label instead of inside it.
 */
export function Field({ label, hint, children, className = '', testId }: FieldProps) {
    const hintId = useId();
    const control = hint && isValidElement<AriaAttributes>(children) ? cloneElement(children, { 'aria-describedby': hintId }) : children;
    return h('div', { className: `flex flex-col gap-1 min-w-0 ${className}`, 'data-testid': testId },
        h('label', { className: 'flex flex-col gap-1 min-w-0' },
            h('span', { className: LABEL_CLASS }, label),
            control),
        hint ? h('span', { id: hintId, className: 'text-[11px] leading-snug text-[var(--text-tertiary)]', 'data-testid': testId ? `${testId}-hint` : undefined }, hint) : null);
}

/** A control that reports its value as a string; the rest passes through to the element. */
type ValueControl<A> = Omit<A, 'value' | 'onChange'> & {
    value?: string | null;
    onChange: (value: string) => void;
};

export type TextInputProps = ValueControl<InputHTMLAttributes<HTMLInputElement>>;

export type TextAreaProps = ValueControl<TextareaHTMLAttributes<HTMLTextAreaElement>>;

export type SelectProps = ValueControl<SelectHTMLAttributes<HTMLSelectElement>> & {
    options: readonly SelectOption[];
};

export function TextInput({ value, onChange, className = '', ...rest }: TextInputProps) {
    return h('input', { className: `${INPUT_CLASS} ${className}`, value: value ?? '', onChange: (e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value), ...rest });
}

export function TextArea({ value, onChange, rows = 2, className = '', ...rest }: TextAreaProps) {
    return h('textarea', { className: `${INPUT_CLASS} resize-y ${className}`, rows, value: value ?? '', onChange: (e: ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value), ...rest });
}

export function DateInput({ value, onChange, className = '', ...rest }: TextInputProps) {
    return h('input', { type: 'date', className: `${INPUT_CLASS} ${className}`, value: value ?? '', onChange: (e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value), ...rest });
}

export function Select({ value, onChange, options, className = '', ...rest }: SelectProps) {
    return h('select', { className: `${INPUT_CLASS} ${className}`, value: value ?? '', onChange: (e: ChangeEvent<HTMLSelectElement>) => onChange(e.target.value), ...rest },
        options.map((o: SelectOption) => h('option', { key: String(o.value), value: o.value }, o.label)));
}

export type UserSelectProps = Omit<SelectProps, 'options'> & {
    orgUsers?: OrgUser[] | null;
    noneLabel?: ReactNode;
};

/** Org-user picker; `noneLabel` is the empty option. */
export function UserSelect({ value, onChange, orgUsers, noneLabel, className = '', ...rest }: UserSelectProps) {
    const options: SelectOption[] = [
        { value: '', label: noneLabel },
        ...(Array.isArray(orgUsers) ? orgUsers : []).map((u: OrgUser) => ({ value: u.id, label: userOptionLabel(u) })),
    ];
    return h(Select, { value, onChange, options, className, ...rest });
}

export interface UserChecklistProps {
    value?: UserId[];
    onChange: (ids: UserId[]) => void;
    orgUsers?: OrgUser[] | null;
    testId?: string;
}

/** Checkbox list of org users → array of ids. */
export function UserChecklist({ value = [], onChange, orgUsers, testId }: UserChecklistProps) {
    const list = Array.isArray(orgUsers) ? orgUsers : [];
    const toggle = (id: UserId) => onChange(value.includes(id) ? value.filter((x: UserId) => x !== id) : [...value, id]);
    return h('div', { className: `${INPUT_CLASS} max-h-[140px] overflow-y-auto flex flex-col gap-1`, 'data-testid': testId },
        list.length === 0 ? h('span', { className: 'text-[var(--text-tertiary)]' }, '—') : null,
        list.map((u: OrgUser) => h('label', { key: u.id, className: 'flex items-center gap-2 text-xs cursor-pointer text-[var(--text-primary)]' },
            h('input', { type: 'checkbox', checked: value.includes(u.id), onChange: () => toggle(u.id) }),
            h('span', { className: 'truncate' }, u.displayName || u.email || u.id))));
}

export interface ToggleProps {
    checked?: boolean;
    onChange: (checked: boolean) => void;
    label?: ReactNode;
    hint?: ReactNode;
    testId?: string;
    disabled?: boolean;
}

/** A checkbox row with the label beside it (settings toggles, SCC confirmations). */
export function Toggle({ checked, onChange, label, hint, testId, disabled }: ToggleProps) {
    return h('label', { className: 'flex items-start gap-2 text-xs cursor-pointer text-[var(--text-primary)]', 'data-testid': testId },
        h('input', { type: 'checkbox', className: 'mt-0.5', checked: !!checked, disabled, onChange: (e: ChangeEvent<HTMLInputElement>) => onChange(e.target.checked) }),
        h('span', { className: 'flex flex-col gap-0.5 min-w-0' },
            h('span', null, label),
            hint ? h('span', { className: 'text-[11px] text-[var(--text-tertiary)]' }, hint) : null));
}

const BUTTON_BASE = 'inline-flex items-center gap-1.5 h-8 px-3 rounded-[10px] text-[12px] font-medium whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed';

type ActionVariant = 'primary' | 'ghost' | Tone;

export type ActionButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'className'> & {
    variant?: ActionVariant;
    icon?: LucideIcon;
    size?: 'sm';
    className?: string;
    children?: ReactNode;
};

/**
 * ActionButton — `variant`:
 *   'primary'  the theme's filled recipe (PRIMARY_ACTION_STYLE), one per surface
 *   'ghost'    hairline + primary text (the default)
 *   a tone     hairline in TONES[tone].raw with ink text — a state transition
 *              ("Start audit" warning, "Close" success, "Raise as NC" error)
 */
export function ActionButton({ variant = 'ghost', icon: Icon, children, className = '', size, ...rest }: ActionButtonProps) {
    const sizeClass = size === 'sm' ? 'h-7 px-2.5 text-[11px]' : '';
    let style: CSSProperties;
    if (variant === 'primary') style = PRIMARY_ACTION_STYLE;
    else if (TONES[variant]) style = { border: `1px solid ${TONES[variant].raw}`, color: TONES[variant].ink, background: 'transparent' };
    else style = { border: '1px solid var(--border-default)', color: 'var(--text-primary)', background: 'var(--bg-card)' };
    return h('button', { type: 'button', className: `${BUTTON_BASE} ${sizeClass} ${className}`, style, ...rest },
        Icon ? h(Icon, { size: 13, 'aria-hidden': 'true' }) : null,
        children);
}

export interface FactProps {
    label?: ReactNode;
    children?: ReactNode;
    testId?: string;
}

/** The quiet "label / value" line the drawers use for a read-only fact. */
export function Fact({ label, children, testId }: FactProps) {
    return h('div', { className: 'flex items-baseline gap-2 text-xs', 'data-testid': testId },
        h('span', { className: `${LABEL_CLASS} shrink-0 min-w-[96px]` }, label),
        h('span', { className: 'text-[var(--text-secondary)] min-w-0 [overflow-wrap:anywhere]' }, children ?? '—'));
}

export interface TextBlockProps {
    children?: ReactNode;
    testId?: string;
}

/** A failed read is its own state, never an empty list. */
export function ReadFailed({ children, testId }: TextBlockProps) {
    return h('div', { className: 'rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] px-3.5 py-3 text-xs text-[var(--text-tertiary)]', 'data-testid': testId }, children);
}

/** The one-line register intro under the header. */
export function Intro({ children, testId }: TextBlockProps) {
    return h('p', { className: 'm-0 text-xs text-[var(--text-secondary)] min-w-0 flex-1', 'data-testid': testId }, children);
}

/**
 * The one page frame of the Compliance Center: 14px padding, 20/16px once the
 * page is 1100px wide, 14px between blocks, 12px text. Every page uses it, so
 * no two pages sit at different distances from the rail.
 */
export const PAGE_FRAME = 'p-3.5 @[1100px]/cpage:px-5 @[1100px]/cpage:py-4 flex flex-col gap-3.5 text-xs';

export interface RegisterLayoutProps {
    toolbar?: ReactNode;
    children?: ReactNode;
    drawer?: ReactNode;
    isMobile?: boolean;
    drawerMode?: SideDrawerMode;
    frameRef?: Ref<HTMLDivElement>;
    testId?: string;
}

/**
 * RegisterLayout — the redesign's register frame: a toolbar row (intro +
 * filters + the ONE primary action), the table in a scrolling pane, and the
 * SideDrawer. `drawer` is the already-built SideDrawer element (or null).
 *
 * Where the drawer goes is `drawerMode` (useDrawerMode): 'inline' beside the
 * table, 'overlay' over it (rendered outside the row, absolute over the
 * frame, behind SideDrawer's scrim), 'modal' on a phone. `frameRef` is the
 * ref useDrawerMode returns: it sits on the row that holds table and drawer,
 * the width the decision is about. Without `drawerMode` the old rule holds:
 * modal on a phone, inline otherwise.
 */
export function RegisterLayout({ toolbar, children, drawer, isMobile = false, drawerMode = undefined, frameRef = undefined, testId }: RegisterLayoutProps) {
    const mode = drawerMode ?? (isMobile ? 'modal' : 'inline');
    const beside = mode === 'inline';
    return h('div', { className: `relative h-full min-h-0 ${PAGE_FRAME}`, 'data-testid': testId, 'data-drawer-mode': drawer ? mode : undefined },
        toolbar ? h('div', { className: 'flex flex-wrap items-center gap-2' }, toolbar) : null,
        h('div', { ref: frameRef, className: 'flex-1 min-h-0 flex gap-3 items-start' },
            h('div', { className: 'flex-1 min-w-0 min-h-0 overflow-y-auto flex flex-col gap-3' }, children),
            beside ? drawer : null),
        beside ? null : drawer);
}
