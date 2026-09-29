import { Calendar, Pencil, Trash2, MapPin, Users, Clock, AlignLeft } from 'lucide-react';
import React from 'react';
import DraftCardShell from './DraftCardShell';
import useDraftAction from '../../../hooks/useDraftAction';
import useTranslation from '../../../hooks/useTranslation';

function formatDateTime(iso) {
    if (!iso) return '';
    try {
        const d = new Date(iso);
        return d.toLocaleString(undefined, {
            weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
            hour: '2-digit', minute: '2-digit'
        });
    } catch { return iso; }
}

/**
 * De duur van een afspraak, als vertaalde zin. `t` komt binnen als argument
 * omdat dit een pure functie buiten de component is — een hook mag hier niet.
 */
function formatDuration(t, start, end) {
    if (!start || !end) return null;
    try {
        const ms = new Date(end) - new Date(start);
        const mins = Math.round(ms / 60000);
        if (mins < 60) return t('chat.draft.cal_dur_min', '{count} min', { count: mins });
        const hrs = Math.floor(mins / 60);
        const rem = mins % 60;
        return rem > 0
            ? t('chat.draft.cal_dur_h_m', '{hours}h {minutes}m', { hours: hrs, minutes: rem })
            : t('chat.draft.cal_dur_h', '{hours}h', { hours: hrs });
    } catch { return null; }
}

function parseAttendees(attendeesStr) {
    if (!attendeesStr) return [];
    return attendeesStr.split(',').map(e => e.trim()).filter(Boolean);
}

export default function CalendarDraftCard({ msg, calendarDraftStatuses, setCalendarDraftStatuses }) {
    const { t } = useTranslation();
    const { confirm, discard, getStatus } = useDraftAction({
        endpoint: '/api/integrations/calendar/execute',
        statuses: calendarDraftStatuses,
        setStatuses: setCalendarDraftStatuses,
    });

    if (!msg.calendarDrafts || msg.calendarDrafts.length === 0) return null;

    const actionLabels = {
        create: t('chat.draft.cal_new', 'New Event'),
        update: t('chat.draft.cal_update', 'Update Event'),
        delete: t('chat.draft.cal_delete', 'Delete Event'),
    };
    const actionIcons = { create: Calendar, update: Pencil, delete: Trash2 };
    const actionColors = {
        create: { border: 'border-emerald-500/30', bg: 'bg-emerald-500/5', text: 'text-emerald-500', btn: 'bg-emerald-600 hover:bg-emerald-500' },
        update: { border: 'border-blue-500/30', bg: 'bg-blue-500/5', text: 'text-blue-500', btn: 'bg-blue-600 hover:bg-blue-500' },
        delete: { border: 'border-red-500/30', bg: 'bg-red-500/5', text: 'text-red-500', btn: 'bg-red-600 hover:bg-red-500' },
    };

    return msg.calendarDrafts.map((draft, i) => {
        const status = getStatus(draft, i);
        const colors = actionColors[draft.action] || actionColors.create;
        const ActionIcon = actionIcons[draft.action] || Calendar;
        const duration = formatDuration(t, draft.startTime, draft.endTime);
        const attendeeList = parseAttendees(draft.attendees);

        return (
            <DraftCardShell
                key={i}
                status={status}
                colors={colors}
                icon={ActionIcon}
                actionLabel={actionLabels[draft.action]}
                executingLabel={t('chat.draft.executing', 'Executing...')}
                confirmLabel={t(
                    draft.action === 'delete' ? 'chat.draft.delete' : 'chat.draft.confirm',
                    draft.action === 'delete' ? 'Delete' : 'Confirm',
                )}
                titleIcon={Calendar}
                title={draft.title}
                // BFSF-254: legacy CREATE drafts persisted in old conversations
                // lack timeZone — fall back to the browser zone at confirm time
                // so Google never receives a bare local dateTime. Updates stay
                // untouched (the server preserves the event's stored zone).
                onConfirm={() => {
                    const needsTz = draft.action === 'create' && !draft.allDay && !draft.timeZone;
                    confirm(needsTz ? { ...draft, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone } : draft, i);
                }}
                onDiscard={() => discard(i)}
            >
                {/* Date/Time with duration */}
                {draft.startTime && (
                    <div className="flex items-start gap-2.5">
                        <Clock className="w-4 h-4 text-[var(--text-tertiary)] flex-shrink-0 mt-0.5" />
                        <div className="flex flex-col gap-0.5">
                            <span className="text-[var(--text-secondary)] text-xs">
                                {formatDateTime(draft.startTime)}
                                {draft.endTime && <span className="text-[var(--text-tertiary)]"> → </span>}
                                {draft.endTime && formatDateTime(draft.endTime)}
                            </span>
                            {(duration || draft.allDay) && (
                                <span className="text-[10px] text-[var(--text-tertiary)]">
                                    {draft.allDay
                                        ? t('chat.draft.cal_all_day', 'All day event')
                                        : t('chat.draft.cal_duration', 'Duration: {duration}', { duration })}
                                </span>
                            )}
                            {/* BFSF-254: show which zone the event lands in so
                                the user can verify before confirming. */}
                            {!draft.allDay && draft.timeZone && (
                                <span className="text-[10px] text-[var(--text-tertiary)]">{draft.timeZone}</span>
                            )}
                        </div>
                    </div>
                )}

                {/* Location */}
                {draft.location && (
                    <div className="flex items-center gap-2.5">
                        <MapPin className="w-4 h-4 text-[var(--text-tertiary)] flex-shrink-0" />
                        <span className="text-[var(--text-secondary)] text-xs">{draft.location}</span>
                    </div>
                )}

                {/* Google Meet */}
                {draft.addGoogleMeet && (
                    <div className="flex items-center gap-2.5">
                        <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="none">
                            <path d="M15.5 10.5V7.5C15.5 6.95 15.05 6.5 14.5 6.5H4.5C3.95 6.5 3.5 6.95 3.5 7.5V16.5C3.5 17.05 3.95 17.5 4.5 17.5H14.5C15.05 17.5 15.5 17.05 15.5 16.5V13.5L20.5 17.5V6.5L15.5 10.5Z" fill="#00897B"/>
                        </svg>
                        <span className="text-xs font-medium" style={{ color: '#00897B' }}>{t('chat.draft.cal_meet_link', 'Google Meet link will be created')}</span>
                    </div>
                )}

                {/* Microsoft Teams */}
                {draft.isOnlineMeeting && (
                    <div className="flex items-center gap-2.5">
                        <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="none">
                            <path d="M15.5 10.5V7.5C15.5 6.95 15.05 6.5 14.5 6.5H4.5C3.95 6.5 3.5 6.95 3.5 7.5V16.5C3.5 17.05 3.95 17.5 4.5 17.5H14.5C15.05 17.5 15.5 17.05 15.5 16.5V13.5L20.5 17.5V6.5L15.5 10.5Z" fill="#6264A7"/>
                        </svg>
                        <span className="text-xs font-medium" style={{ color: '#6264A7' }}>{t('chat.draft.cal_teams_link', 'Microsoft Teams link will be created')}</span>
                    </div>
                )}

                {/* Attendees — shown as individual tags */}
                {attendeeList.length > 0 && (
                    <div className="flex items-start gap-2.5">
                        <Users className="w-4 h-4 text-[var(--text-tertiary)] flex-shrink-0 mt-0.5" />
                        <div className="flex flex-wrap gap-1.5">
                            {attendeeList.map((email, j) => (
                                <span key={j} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] bg-[var(--bg-tertiary)] text-[var(--text-secondary)] border border-[var(--border-subtle)]">
                                    <span className="w-1.5 h-1.5 rounded-full bg-blue-400 flex-shrink-0" />
                                    {email}
                                </span>
                            ))}
                        </div>
                    </div>
                )}

                {/* Description */}
                {draft.description && (
                    <div className="flex items-start gap-2.5 mt-1">
                        <AlignLeft className="w-4 h-4 text-[var(--text-tertiary)] flex-shrink-0 mt-0.5" />
                        <div className="flex-1 p-2 rounded-lg bg-[var(--bg-primary)] border border-[var(--border-subtle)] text-xs text-[var(--text-secondary)] whitespace-pre-wrap max-h-[200px] overflow-y-auto custom-scrollbar">
                            {draft.description}
                        </div>
                    </div>
                )}

                {/* Delete action — show event ID */}
                {draft.action === 'delete' && !draft.startTime && (
                    <div className="text-xs text-[var(--text-secondary)]">{t('chat.draft.cal_event_id', 'Event ID: {id}', { id: draft.eventId })}</div>
                )}
            </DraftCardShell>
        );
    });
}
