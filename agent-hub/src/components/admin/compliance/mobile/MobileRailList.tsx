/**
 * MobileRailList — the rail's rows as a phone list (artboard 1h, the
 * "Kaders" and "Registers" segments).
 *
 * Same registry (sections.js), same visibility rule (visibleSections: a
 * growing-set framework or register shows only once the org enabled it) and
 * the same meta and hint (railMeta / railHint) as the desktop rail — only
 * the chrome differs: one card per group, rows of at least 44px (hit-target
 * rule of the frame), a chevron at the right. A meta of `null` renders
 * nothing; nothing here ever prints a 0 the server did not state. The hint
 * (a row's background figures) is the row's tooltip and its accessible
 * description, as on the desktop rail.
 */
import { ChevronRight, Timer, type LucideIcon } from 'lucide-react';
import React, { useId } from 'react';
import { useTranslation, type TranslateParams } from '@/hooks/useTranslation';
import DeadlineClock from '@/components/shared/DeadlineClock';
import type { TimeInput } from '@/components/shared/deadlineMath';
import { TONES } from '@/components/shared/statusTone';
import { visibleSections } from '../ComplianceRail';
import railMeta, { railHint, railRowTitle } from '../railMeta';
import { GROUPS, sectionsInGroup } from '../sections';

interface SectionLike {
    id: string;
    icon?: LucideIcon;
    labelKey: string;
    labelFallback: string;
}

export const MOBILE_ROW_CLASS = 'w-full flex items-center gap-3 px-3.5 py-2.5 min-h-[44px] text-left';

/** The right-hand meta of a row, from a railMeta descriptor. */
interface RailMetaTextProps {
    meta: {
        kind: string;
        text?: React.ReactNode;
        score?: number;
        tone?: string | null;
        badge?: string | null;
        dueAt?: TimeInput;
        startedAt?: TimeInput;
        urgentBelowMs?: number | null;
        suffix?: React.ReactNode;
    } | null;
}

function RailMetaText({ meta }: RailMetaTextProps) {
    if (!meta) return null;
    if (meta.kind === 'text') {
        return <span className="text-[11px] whitespace-nowrap text-[var(--text-tertiary)]">{meta.text}</span>;
    }
    if (meta.kind === 'score') {
        const tone = TONES[meta.tone as string] || TONES.neutral;
        return (
            <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold tabular-nums text-[var(--text-primary)]">
                <span aria-hidden="true" className="inline-block w-2 h-2 rounded-full" style={{ background: tone.raw }} />
                {meta.score}
            </span>
        );
    }
    if (meta.kind === 'clock') {
        const tone = meta.tone ? (TONES[meta.tone] || TONES.neutral) : null;
        return (
            <span className="inline-flex items-center gap-1.5 text-[11px] whitespace-nowrap">
                {meta.badge && tone && (
                    <span className="inline-flex items-center gap-[3px] font-semibold tabular-nums" style={{ color: tone.ink }}>
                        <Timer size={11} aria-hidden="true" />{meta.badge}
                    </span>
                )}
                {!meta.badge && meta.dueAt && (
                    <DeadlineClock variant="rail" dueAt={meta.dueAt} startedAt={meta.startedAt} urgentBelowMs={meta.urgentBelowMs} />
                )}
                {meta.suffix && <span className="text-[var(--text-tertiary)]">{meta.suffix}</span>}
            </span>
        );
    }
    return null;
}

interface MobileCardProps {
    children?: React.ReactNode;
    className?: string;
    testId: string;
}

export function MobileCard({ children, className = '', testId }: MobileCardProps) {
    return (
        <div data-testid={testId} className={`rounded-xl overflow-hidden ${className} [background:var(--bg-card)] [border:1px_solid_var(--border-default)] [box-shadow:var(--shadow-sm)]`}>
            {children}
        </div>
    );
}

interface MobileSectionRowProps {
    section: SectionLike;
    meta: RailMetaTextProps['meta'];
    hint?: string | null;
    active: boolean;
    onClick: React.MouseEventHandler<HTMLButtonElement>;
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
}

function MobileSectionRow({ section, meta, hint = null, active, onClick, t }: MobileSectionRowProps) {
    const Icon = section.icon;
    const label = t(section.labelKey, section.labelFallback);
    const hintId = `${useId()}-hint`;
    return (
        <>
            {/* Before the button, so the row stays the card's `last:` child. */}
            {hint && <span id={hintId} className="sr-only" data-testid={`mobile-hint-${section.id}`}>{hint}</span>}
            <button type="button" data-testid={`mobile-row-${section.id}`} aria-current={active ? 'page' : undefined}
                title={railRowTitle(label, hint)} aria-describedby={hint ? hintId : undefined}
                onClick={onClick} className={`${MOBILE_ROW_CLASS} border-b last:border-b-0`}
                style={{ borderColor: 'var(--border-default)', background: active ? 'var(--bg-tertiary)' : 'transparent' }}>
                {Icon && <Icon size={16} aria-hidden="true" className="flex-shrink-0" style={{ color: active ? 'var(--kind-compliance)' : 'var(--text-secondary)' }} />}
                <span className="flex-1 min-w-0 truncate text-[13px] font-medium text-[var(--text-primary)]">
                    {label}
                </span>
                <RailMetaText meta={meta} />
                <ChevronRight size={16} aria-hidden="true" className="flex-shrink-0 text-[var(--text-tertiary)]" />
            </button>
        </>
    );
}

/**
 * Props
 *   groups     rail group ids to list, in order ('frameworks' | 'registers' | 'admin')
 *   counts     GET /counts object | null
 *   frameworks the frameworks aggregate (isEnabled) — decides optional rows
 *   active     current section id (marks the row)
 *   onSelect   (sectionId) → void
 *   showHeads  print the group heading above each card (registers view)
 */
interface MobileRailListProps {
    groups: string[];
    counts: unknown;
    frameworks?: { isEnabled?: (id: string) => boolean } | null;
    onSelect: (sectionId: string) => void;
    active: string;
    showHeads?: boolean;
    testId?: string;
}

export default function MobileRailList({ groups, counts, frameworks, active, onSelect, showHeads = false, testId = 'mobile-rail-list' }: MobileRailListProps) {
    const { t } = useTranslation();
    return (
        <div data-testid={testId} className="flex flex-col gap-3">
            {groups.map((groupId) => {
                const group = GROUPS.find(g => g.id === groupId);
                const rows = visibleSections(sectionsInGroup(groupId), { counts, frameworks });
                if (!rows.length) return null;
                return (
                    <div key={groupId} className="flex flex-col gap-2">
                        {showHeads && group && (
                            <div className="text-[11px] font-semibold uppercase tracking-wide px-1 text-[var(--text-tertiary)]">
                                {t(group.labelKey, group.labelFallback)}
                            </div>
                        )}
                        <MobileCard testId={`${testId}-${groupId}`}>
                            {rows.map((s: SectionLike) => (
                                <MobileSectionRow key={s.id} section={s} meta={railMeta(s, counts, t)} hint={railHint(s, counts, t)}
                                    active={active === s.id} onClick={() => onSelect(s.id)} t={t} />
                            ))}
                        </MobileCard>
                    </div>
                );
            })}
        </div>
    );
}
