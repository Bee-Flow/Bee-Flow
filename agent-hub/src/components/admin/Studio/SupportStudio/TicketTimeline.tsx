import React, { useCallback } from 'react';
import { useTicketEventsQuery } from '../../../../api/queries/supportPanels';
import useTranslation from '../../../../hooks/useTranslation';
import { metaFor } from './auditMeta';
import type { SupportTeammate } from './supportStudio.types';
import type { SupportEvent } from '../../../support/SupportInboxPanel.types';

const NO_EVENTS: SupportEvent[] = [];

interface TicketTimelineProps {
    threadId: string;
    teammates?: SupportTeammate[];
}

/**
 * TicketTimeline — the per-ticket audit trail. Reads the unified audit feed
 * (/threads/:id/events) which now distinguishes system / automation / AI / staff
 * / requester precisely, and renders each as an icon + coloured category chip +
 * human label + payload summary. Newest-first.
 */
export default function TicketTimeline({ threadId, teammates = [] }: TicketTimelineProps) {
    const { t } = useTranslation();
    const eventsQuery = useTicketEventsQuery<SupportEvent>(threadId);
    const events = eventsQuery.data ?? NO_EVENTS;
    const loading = eventsQuery.isFetching;

    const nameFor = useCallback((id?: string | null) => {
        if (!id) return '';
        const tm = teammates.find(x => x.id === id);
        return tm ? (tm.name || tm.email || id) : id;
    }, [teammates]);


    if (loading) return <div className="text-[11px] text-[var(--text-tertiary)] italic px-1 py-1">{t('support.common.loading', 'Loading…')}</div>;
    if (events.length === 0) return <div className="text-[11px] text-[var(--text-tertiary)] italic px-1 py-1">{t('support.activity.empty', 'No activity yet.')}</div>;

    return (
        <div className="flex flex-col gap-2 py-1">
            {events.map(ev => {
                const m = metaFor(ev, t);
                const Icon = m.Icon;
                const who = ev.actor_user_id ? nameFor(ev.actor_user_id) : m.label;
                return (
                    <div key={ev.id} className="flex items-start gap-2.5">
                        <span className={`mt-0.5 inline-flex items-center justify-center w-5 h-5 rounded-full border shrink-0 ${m.chip}`}>
                            <Icon size={11} style={{ color: m.color }} />
                        </span>
                        <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5 flex-wrap text-[12px]">
                                <span className="text-[var(--text-primary)]">{m.label}</span>
                                {m.summary && <span className="text-[var(--text-tertiary)] truncate">· {m.summary}</span>}
                            </div>
                            <div className="text-[10px] text-[var(--text-tertiary)] tabular-nums">
                                {new Date(ev.created_at).toLocaleString()}{ev.actor_user_id ? ` · ${who}` : ''}
                            </div>
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
