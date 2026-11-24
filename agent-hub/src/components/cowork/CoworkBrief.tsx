/**
 * The brief of one cowork item (./CoworkDetail.tsx): the assignment in the user's own words, and the context it runs
 * under as pills.
 *
 * TWO PILLS THE ARTBOARD DRAWS ARE NOT HERE, deliberately:
 *
 *   - "Prijslijst 2026" and "Offertes" (a knowledge base and a table). A
 *     cowork item has no knowledge-base or datatable binding at all — that is
 *     new datamodel, CW-09 — so those pills could only ever name a source
 *     this run will not read.
 *   - "Privacyschild aan". The non-agent run path calls the adapter directly
 *     with no shield in it (CW-10). The pill is a runtime claim, and on a
 *     privacy product a claim you cannot keep is worse than a missing pill.
 *     It arrives with the shield itself, not before it.
 *
 * Every pill that IS here states something the item actually carries.
 */
import { CalendarClock, Clock, LayoutGrid } from 'lucide-react';
import type { ComponentType, CSSProperties, ReactNode } from 'react';
import { cadenceLine, describeMoment } from './coworkSchedule';
import { describeMailTrigger, isMailTriggerItem } from './mailTrigger';
import { TIER_META, tierLabel } from '../licensing/tierMeta';
import { kindColorVar, kindIcon } from '../shared/kindColors';
import CoworkGoal from './CoworkGoal';
import type { CoworkAgent, CoworkItem } from '@/api/cowork.types';
import type { TranslateFn } from '@/hooks/useTranslation';

const AgentIcon = kindIcon('agent');

interface PillProps {
    icon: ComponentType<{ 'aria-hidden'?: boolean | 'true' | 'false'; className?: string; style?: CSSProperties }>;
    tone: string;
    children: ReactNode;
}

/**
 * One context pill. The colour is always a kind/type token from index.css
 * (through kindColors), never a colour picked here — a clock pill is the same
 * teal as a trigger node in the Builder because it means the same thing.
 */
function Pill(props: PillProps) {
    const Glyph = props.icon;
    const { tone, children } = props;
    return (
        <span
            className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full border text-[11.5px] max-w-full bg-[var(--bg-card)] border-[var(--border-subtle)] text-[var(--text-secondary)]"
        >
            <Glyph aria-hidden="true" className="w-3 h-3 flex-shrink-0" style={{ color: tone }} />
            <span className="truncate">{children}</span>
        </span>
    );
}

/** "Every weekday 08:00", "Every Tuesday 06:30", or "Runs once". */
function cadenceText(item: CoworkItem, t: TranslateFn) {
    if (isMailTriggerItem(item)) return describeMailTrigger(item.trigger, t);
    const days = Array.isArray(item.daysOfWeek) && item.daysOfWeek.length > 0;
    if (!item.repeatInterval && !days) return t('cowork.detail.runs_once', 'Runs once');
    return cadenceLine(item, t);
}

/** The brief in the user's own words, and the context it runs under. */
export default function AssignmentCard({ item, agents, t }: { item: CoworkItem; agents?: CoworkAgent[]; t: TranslateFn }) {
    const agent = item.agentId && Array.isArray(agents)
        ? agents.find(a => a.id === item.agentId)
        : null;
    const tierKey = item.modelTier || null;
    const TierIcon = (tierKey && TIER_META[tierKey]?.Icon) || null;
    const appCount = Array.isArray(item.enabledApps) ? item.enabledApps.length : 0;

    return (
        <section
            className="rounded-[10px] border px-[18px] py-4 flex flex-col gap-2.5 [background:var(--bg-card)] [border-color:var(--border-subtle)] [box-shadow:var(--shadow-sm)]"
            data-testid="cowork-brief"
        >
            <h3
                className="text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]"
            >
                {t('cowork.detail.assignment', 'The assignment')}
            </h3>
            {/* Still plain text, still not Markdown: this is what the user
                typed, and a brief that opened with "# Weekly" is a sentence,
                not a heading. */}
            <p
                className="text-[13px] leading-[21px] max-w-[820px] whitespace-pre-wrap break-words text-[var(--text-secondary)]"
            >
                {item.prompt}
            </p>
            {/* The goal line: one sentence under the brief that says what "done well" means for this work, and what
                its check counted after the last run (./CoworkGoal.tsx). */}
            <CoworkGoal coworkId={item.id} />
            <div className="flex gap-1.5 flex-wrap pt-0.5">
                <Pill icon={Clock} tone="var(--type-trigger)">{cadenceText(item, t)}</Pill>
                {item.isActive && item.nextRunAt && (
                    <Pill icon={CalendarClock} tone="var(--type-trigger)">
                        {t('cowork.detail.next_run', 'next {when}', { when: describeMoment(item.nextRunAt) })}
                    </Pill>
                )}
                {agent && <Pill icon={AgentIcon} tone={kindColorVar('agent')}>{agent.name}</Pill>}
                {TierIcon && (
                    // The TIER, not a model name. Models are bound to tiers on
                    // purpose, and under `auto` no model has been chosen yet
                    // when this renders (B4).
                    <Pill icon={TierIcon} tone="var(--type-ai)">{tierLabel(tierKey)}</Pill>
                )}
                {appCount > 0 && (
                    <Pill icon={LayoutGrid} tone={kindColorVar('app')}>
                        {t(
                            appCount === 1 ? 'cowork.detail.app_count' : 'cowork.detail.app_count_plural',
                            appCount === 1 ? '{count} app' : '{count} apps',
                            { count: appCount },
                        )}
                    </Pill>
                )}
            </div>
        </section>
    );
}
