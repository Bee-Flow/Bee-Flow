import { Activity, Loader2, PlayCircle } from 'lucide-react';
import React from 'react';
import { SECTIONS } from './ProjectResourcesTab';
import { useTranslation } from '../../hooks/useTranslation';

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
                        className="flex flex-col gap-1 px-3 py-3 rounded-lg text-left"
                        style={{ background: 'var(--bg-secondary)' }}
                    >
                        <span className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                            <Icon className="w-3.5 h-3.5" />
                            {t(labelKey)}
                        </span>
                        <span className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>
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
        <div>
            <h3 className="flex items-center gap-2 text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
                <PlayCircle className="w-4 h-4" style={{ color: 'var(--text-tertiary)' }} />
                {t('projects.running_now', 'Running now')}
            </h3>
            <div className="space-y-1.5">
                {runs.map(run => (
                    <div key={run.runId} className="flex items-center gap-3 px-3 py-2 rounded-lg"
                         style={{ background: 'var(--bg-secondary)' }}>
                        <Loader2 className="w-3.5 h-3.5 animate-spin flex-shrink-0" style={{ color: 'var(--text-tertiary)' }} />
                        <span className="flex-1 min-w-0 text-sm truncate" style={{ color: 'var(--text-primary)' }}>
                            {run.automationTitle || t('projects.untitled_automation', 'Untitled automation')}
                        </span>
                    </div>
                ))}
            </div>
        </div>
    );
}

function Recent({ activity, formatActivity, formatRelative }) {
    const { t } = useTranslation();
    return (
        <div>
            <h3 className="flex items-center gap-2 text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
                <Activity className="w-4 h-4" style={{ color: 'var(--text-tertiary)' }} />
                {t('projects.recent_activity', 'Recent activity')}
            </h3>
            {activity.length === 0 ? (
                <p className="px-3 py-2.5 rounded-lg text-xs"
                   style={{ background: 'var(--bg-secondary)', color: 'var(--text-tertiary)' }}>
                    {t('projects.section_empty', 'Nothing here yet.')}
                </p>
            ) : (
                <ul className="space-y-1.5">
                    {activity.slice(0, COMPACT_ACTIVITY).map(item => (
                        <li key={item.id} className="px-3 py-2 rounded-lg" style={{ background: 'var(--bg-secondary)' }}>
                            <p className="text-sm truncate" style={{ color: 'var(--text-primary)' }}>
                                {formatActivity ? formatActivity(item) : item.action}
                            </p>
                            <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                                {formatRelative ? formatRelative(item.createdAt) : ''}
                            </p>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

export default function ProjectOverviewTab({
    resources, loading, activity = [], activeRuns = {},
    onOpenTab, formatActivity, formatRelative,
}) {
    if (loading && !resources) {
        return (
            <div className="flex items-center justify-center py-16" style={{ color: 'var(--text-tertiary)' }}>
                <Loader2 className="w-5 h-5 animate-spin" />
            </div>
        );
    }
    return (
        <div className="space-y-6">
            <CountTiles resources={resources} onOpenTab={onOpenTab} />
            <RunningNow runs={Object.values(activeRuns)} />
            <Recent activity={activity} formatActivity={formatActivity} formatRelative={formatRelative} />
        </div>
    );
}
