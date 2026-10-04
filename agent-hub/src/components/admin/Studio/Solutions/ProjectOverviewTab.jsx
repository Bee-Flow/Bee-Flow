import { Activity, Loader2, PlayCircle } from 'lucide-react';
import React from 'react';
import { kindBarClass, kindInkClass } from './kindBar';
import { SECTIONS } from './solutionSections';
import { ROW, TabCard, TabNote, TabSpinner } from './TabParts';
import { useTranslation } from '../../../../hooks/useTranslation';

/**
 * What this project IS, at a glance.
 *
 * The Content tab answers "what is filed here", one list per kind. This one
 * answers the question that made the four kinds worth putting in one place: is
 * this a working solution, and is any of it running right now?
 *
 * Three bands, in the order you actually want them:
 *
 *   1. THE SHAPE — a count per kind, so "3 automations, 2 apps, 1 webpage"
 *      reads as one thing rather than four tabs you have to visit.
 *   2. RUNNING NOW — live, from the project feed. This band only works because
 *      automation runs are bridged into the same ordered, cross-replica channel
 *      chat already used; polling instead would miss any run shorter than the
 *      interval.
 *   3. RECENT — the durable activity trail, compact.
 *
 * Counts come from the SAME resources payload the Content tab renders, and the
 * section list is imported rather than restated, so the two can never disagree
 * about which kinds exist.
 *
 * `null` and `[]` still mean different things: a section whose store could not
 * be reached shows a dash, not a zero. Telling someone they have no automations
 * when the truth is "we could not ask" is the worse failure.
 */

const COMPACT_ACTIVITY = 8;

const ICON = 'w-4 h-4 flex-shrink-0 ';
const TILE = 'flex flex-col gap-1 px-3 py-3 min-h-[44px] text-left bg-[var(--bg-card)] border border-[var(--border-subtle)] border-l-[3px] rounded-[var(--radius-md)] transition-colors duration-150 hover:bg-[var(--bg-card-hover)] hover:border-[var(--border-default)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]';

/** null = the store could not be reached, and must not render as 0. */
function countOf(items) {
    return (items === null || items === undefined) ? null : items.length;
}

/** Approvals count what is still waiting, not how many ever existed. */
function pendingCount(items) {
    if (items === null || items === undefined) return null;
    return items.filter(a => (a.status || 'pending') === 'pending').length;
}

function CountTiles({ resources, onOpenTab }) {
    const { t } = useTranslation();
    return (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
            {SECTIONS.map(({ key, icon: Icon, labelKey, kind }) => {
                const items = resources?.[key];
                const count = kind === 'approval' ? pendingCount(items) : countOf(items);
                return (
                    <button
                        key={key}
                        onClick={() => onOpenTab?.('resources')}
                        className={`${TILE} ${kindBarClass(kind)}`}
                    >
                        <span className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
                            <Icon className={ICON + kindInkClass(kind)} aria-hidden="true" />
                            {t(labelKey)}
                        </span>
                        <span className="text-xl font-semibold tabular-nums text-[var(--text-primary)]">
                            {count === null ? '—' : count}
                        </span>
                    </button>
                );
            })}
        </div>
    );
}

function RunningNow({ runs }) {
    const { t } = useTranslation();
    if (runs.length === 0) return null;
    return (
        <TabCard title={t('projects.running_now', 'Running now')} icon={PlayCircle}>
            <div className="space-y-1.5">
                {runs.map(run => (
                    <div key={run.runId} className={`flex items-center gap-3 px-3 py-2.5 ${ROW}`}>
                        <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none flex-shrink-0 text-[var(--accent-primary)]" aria-hidden="true" />
                        <span className="flex-1 min-w-0 text-sm truncate text-[var(--text-primary)]">
                            {run.automationTitle || t('projects.untitled_automation', 'Untitled automation')}
                        </span>
                    </div>
                ))}
            </div>
        </TabCard>
    );
}

function Recent({ activity, formatActivity, formatRelative }) {
    const { t } = useTranslation();
    return (
        <TabCard title={t('projects.recent_activity', 'Recent activity')} icon={Activity}>
            {activity.length === 0 ? (
                <TabNote>{t('projects.section_empty', 'Nothing here yet.')}</TabNote>
            ) : (
                <ul className="space-y-1.5">
                    {activity.slice(0, COMPACT_ACTIVITY).map(item => (
                        <li key={item.id} className={`px-3 py-2 ${ROW}`}>
                            <p className="text-sm truncate text-[var(--text-primary)]">
                                {formatActivity ? formatActivity(item) : item.action}
                            </p>
                            <p className="text-[11px] text-[var(--text-muted)]">
                                {formatRelative ? formatRelative(item.createdAt) : ''}
                            </p>
                        </li>
                    ))}
                </ul>
            )}
        </TabCard>
    );
}

export default function ProjectOverviewTab({
    resources, loading, activity = [], activeRuns = {},
    onOpenTab, formatActivity, formatRelative,
}) {
    if (loading && !resources) {
        return <TabSpinner />;
    }
    return (
        <div className="space-y-6">
            <CountTiles resources={resources} onOpenTab={onOpenTab} />
            <RunningNow runs={Object.values(activeRuns)} />
            <Recent activity={activity} formatActivity={formatActivity} formatRelative={formatRelative} />
        </div>
    );
}
