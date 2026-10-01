// The small recipes the Sprints, Sprint builder and Planning poker views share:
// the chip recipe of the tasks area with state tones, a sprint's status chip, a
// thin progress bar (a styled <progress>, so no inline width), the menu and
// toolbar classes (from tasksMenu, so every Tasks menu looks the same), and the
// short date format. The work item type chip is TaskFields' TypeChip. Tokens only.

import { Info } from 'lucide-react';
import React, { type ComponentType } from 'react';
import type { TaskStatus } from '../../../../api/queries/projectTasks';
import type { Sprint } from '../../../../api/queries/projectSprints';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import { useTranslation } from '../../../../hooks/useTranslation';
import AnchoredMenuJs from '../../../shared/AnchoredMenu';
import { CHIP_CLASS, StatusGlyph } from './TaskFields';
import { ICON_BUTTON_CLASS, MENU_ITEM_CLASS, MENU_PANEL_CLASS, TOOLBAR_BUTTON_CLASS } from './tasksMenu';

// A .jsx module whose `= null` defaults would type the props as null-only.
export const AnchoredMenu = AnchoredMenuJs as unknown as ComponentType<Record<string, unknown>>;

export type ChipTone = 'neutral' | 'info' | 'success' | 'warning' | 'error';

const CHIP = `${CHIP_CLASS} flex-none`;
const CHIP_TONE: Record<ChipTone, string> = {
    neutral: 'bg-[var(--bg-secondary)] text-[var(--text-secondary)]',
    info: 'bg-[color-mix(in_srgb,var(--info)_14%,transparent)] text-[var(--info-ink)]',
    success: 'bg-[color-mix(in_srgb,var(--success)_14%,transparent)] text-[var(--success-ink)]',
    warning: 'bg-[color-mix(in_srgb,var(--warning)_14%,transparent)] text-[var(--warning-ink)]',
    error: 'bg-[color-mix(in_srgb,var(--error)_14%,transparent)] text-[var(--error-ink)]',
};

export function Chip({ tone = 'neutral', title, children, testId }: { tone?: ChipTone; title?: string; children: React.ReactNode; testId?: string }) {
    return <span className={`${CHIP} ${CHIP_TONE[tone]}`} title={title} data-testid={testId}>{children}</span>;
}

/** A one-line explanation behind an info glyph (tooltip, and read out by screen readers). */
export function InfoTip({ text }: { text: string }) {
    return (
        <span role="img" aria-label={text} title={text} className="inline-grid flex-none place-items-center text-[var(--text-tertiary)]">
            <Info className="w-3.5 h-3.5" aria-hidden="true" />
        </span>
    );
}

function sprintStatusLabel(t: TranslateFn, status: Sprint['status']): string {
    if (status === 'active') return t('project_tasks.sprint_status_active', 'Active');
    if (status === 'closed') return t('project_tasks.sprint_status_closed', 'Done');
    return t('project_tasks.sprint_status_planned', 'Planned');
}

const SPRINT_TONE: Record<Sprint['status'], ChipTone> = { planned: 'neutral', active: 'info', closed: 'success' };

export function SprintStatusChip({ status }: { status: Sprint['status'] }) {
    const { t } = useTranslation();
    return <Chip tone={SPRINT_TONE[status]}>{sprintStatusLabel(t, status)}</Chip>;
}

/** A task's status in the list's glyphs, named in its tooltip and for screen readers. */
export function StatusDot({ status }: { status: TaskStatus }) {
    return <StatusGlyph status={status} />;
}

type BarTone = 'success' | 'warning' | 'accent';
const BAR_FILL: Record<BarTone, string> = {
    success: '[&::-webkit-progress-value]:bg-[var(--success)] [&::-moz-progress-bar]:bg-[var(--success)]',
    warning: '[&::-webkit-progress-value]:bg-[var(--warning)] [&::-moz-progress-bar]:bg-[var(--warning)]',
    accent: '[&::-webkit-progress-value]:bg-[var(--accent-primary)] [&::-moz-progress-bar]:bg-[var(--accent-primary)]',
};

/** A thin progress bar: a native <progress>, so the fill needs no inline width. */
export function ProgressBar({ value, max, tone = 'success', label, className = '' }: {
    value: number; max: number; tone?: BarTone; label: string; className?: string;
}) {
    return (
        <progress value={Math.min(value, max || 0)} max={max || 1} aria-label={label} title={label}
            className={`block h-1 min-w-0 appearance-none overflow-hidden rounded-full border-0 bg-[var(--bg-tertiary)] [&::-webkit-progress-bar]:rounded-full [&::-webkit-progress-bar]:bg-[var(--bg-tertiary)] [&::-webkit-progress-value]:rounded-full [&::-moz-progress-bar]:rounded-full ${BAR_FILL[tone]} ${className}`.trim()} />
    );
}

/** `28 Sep` in the reader's locale; the day is a calendar date, so UTC noon keeps it stable. */
function formatDay(day: string, locale: string): string {
    const d = new Date(`${day}T12:00:00Z`);
    return Number.isNaN(d.getTime()) ? day : d.toLocaleDateString(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

export function formatSprintDates(t: TranslateFn, sprint: Pick<Sprint, 'startDate' | 'endDate'>, locale: string): string {
    if (sprint.startDate && sprint.endDate) return `${formatDay(sprint.startDate, locale)} – ${formatDay(sprint.endDate, locale)}`;
    if (sprint.startDate) return formatDay(sprint.startDate, locale);
    return t('project_tasks.sprint_no_dates', 'Dates not set');
}

export function pointsText(t: TranslateFn, points: number | null): string {
    return points ? t('project_tasks.points_short', '{points} pts', { points }) : '—';
}

// The Tasks design language, as class strings.
export const META = 'text-[11.5px] text-[var(--text-tertiary)]';
export const SECTION_LABEL = 'm-0 text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--text-tertiary)]';
export const CARD = 'rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)]';
export const ROW_LIST = `${CARD} m-0 list-none p-0 divide-y divide-[var(--border-subtle)] overflow-hidden`;
export const TOOLBAR_BUTTON = TOOLBAR_BUTTON_CLASS;
export const ICON_BUTTON = `${ICON_BUTTON_CLASS} flex-none`;
/** Row actions: shown on hover or focus, always on touch screens. */
export const REVEAL = 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity';
export const MENU_PANEL = MENU_PANEL_CLASS;
export const MENU_ITEM = MENU_ITEM_CLASS;
export const MENU_ICON = 'w-3.5 h-3.5 flex-none text-[var(--text-tertiary)]';
export const SMALL_INPUT = 'h-8 w-full min-w-0 px-2.5 rounded-lg text-[13px] border border-[var(--border-default)] bg-[var(--bg-primary)] '
    + 'text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus-visible:outline focus-visible:outline-2 '
    + 'focus-visible:outline-offset-1 focus-visible:outline-[var(--accent-primary)] disabled:opacity-60';
