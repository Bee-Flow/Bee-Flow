/**
 * MobileRailList — the rail's rows as a phone list (artboard 1h, the
 * "Kaders" and "Registers" segments).
 *
 * Same registry (sections.js), same visibility rule (visibleSections: a
 * growing-set framework or register shows only once the org enabled it) and
 * the same meta (railMeta) as the desktop rail — only the chrome differs:
 * one card per group, rows of at least 44px (hit-target rule of the frame),
 * a chevron at the right. A meta of `null` renders nothing; nothing here
 * ever prints a 0 the server did not state.
 */
import React from 'react';
import { ChevronRight, Timer } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { GROUPS, sectionsInGroup } from '../sections';
import railMeta from '../railMeta';
import { visibleSections } from '../ComplianceRail';
import { TONES } from '../../../shared/statusTone';

export const MOBILE_ROW_CLASS = 'w-full flex items-center gap-3 px-3.5 py-2.5 min-h-[44px] text-left';

/** The right-hand meta of a row, from a railMeta descriptor. */
export function RailMetaText({ meta }) {
    if (!meta) return null;
    if (meta.kind === 'text') {
        return <span className="text-[11px] whitespace-nowrap" style={{ color: 'var(--text-tertiary)' }}>{meta.text}</span>;
    }
    if (meta.kind === 'score') {
        const tone = TONES[meta.tone] || TONES.neutral;
        return (
            <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold tabular-nums" style={{ color: 'var(--text-primary)' }}>
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
                {meta.suffix && <span style={{ color: 'var(--text-tertiary)' }}>{meta.suffix}</span>}
            </span>
        );
    }
    return null;
}

export function MobileCard({ children, className = '', testId }) {
    return (
        <div data-testid={testId} className={`rounded-xl overflow-hidden ${className}`}
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border-default)', boxShadow: 'var(--shadow-sm)' }}>
            {children}
        </div>
    );
}

export function MobileSectionRow({ section, meta, active, onClick, t }) {
    const Icon = section.icon;
    return (
        <button type="button" data-testid={`mobile-row-${section.id}`} aria-current={active ? 'page' : undefined}
            onClick={onClick} className={`${MOBILE_ROW_CLASS} border-b last:border-b-0`}
            style={{ borderColor: 'var(--border-default)', background: active ? 'var(--bg-tertiary)' : 'transparent' }}>
            {Icon && <Icon size={16} aria-hidden="true" className="flex-shrink-0" style={{ color: active ? 'var(--kind-compliance)' : 'var(--text-secondary)' }} />}
            <span className="flex-1 min-w-0 truncate text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                {t(section.labelKey, section.labelFallback)}
            </span>
            <RailMetaText meta={meta} />
            <ChevronRight size={16} aria-hidden="true" className="flex-shrink-0" style={{ color: 'var(--text-tertiary)' }} />
        </button>
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
export default function MobileRailList({ groups, counts, frameworks, active, onSelect, showHeads = false, testId = 'mobile-rail-list' }) {
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
                            <div className="text-[11px] font-semibold uppercase tracking-wide px-1" style={{ color: 'var(--text-tertiary)' }}>
                                {t(group.labelKey, group.labelFallback)}
                            </div>
                        )}
                        <MobileCard testId={`${testId}-${groupId}`}>
                            {rows.map((s) => (
                                <MobileSectionRow key={s.id} section={s} meta={railMeta(s, counts, t)} active={active === s.id}
                                    onClick={() => onSelect(s.id)} t={t} />
                            ))}
                        </MobileCard>
                    </div>
                );
            })}
        </div>
    );
}
