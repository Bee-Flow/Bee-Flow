/**
 * A calendar action the assistant drafted — create, update or delete an
 * event (the web's CalendarDraftCard): when, how long, where, who, whether a
 * Meet or Teams link will be made, and the description. A create without a
 * time zone gets the phone's at confirm time (BFSF-254, draftPayloads.ts).
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { executeDraft } from '@/features/chat/api/drafts';
import { useDraftAction } from '@/features/chat/hooks/useDraftAction';
import { attendeesOf, eventDuration, formatDateTime, text } from '@/features/chat/model/draftView';
import { executeHeader } from '@/features/chat/model/executeHeader';
import type { DraftRecord } from '@/features/chat/model/types';
import { Button, type IconName } from '@/shared/ui';

import { DraftCardShell, type DraftTone } from './DraftCardShell';
import { DraftField } from './DraftField';

const LOOK: Readonly<Record<string, { icon: IconName; tone: DraftTone }>> = {
    create: { icon: 'Calendar', tone: 'info' },
    update: { icon: 'Pencil', tone: 'warning' },
    delete: { icon: 'Trash2', tone: 'error' },
};

export function CalendarDraftCard({ draft, draftKey }: { draft: DraftRecord; draftKey: string }) {
    const t = useTranslation();
    const state = useDraftAction(draftKey, draft.status);
    const action = text(draft, 'action') || 'create';
    const look = LOOK[action] ?? (LOOK.create as { icon: IconName; tone: DraftTone });
    const label =
        action === 'delete'
            ? t('chat.draft.cal_delete', 'Delete Event')
            : action === 'update'
              ? t('chat.draft.cal_update', 'Update Event')
              : t('chat.draft.cal_new', 'New Event');
    const start = text(draft, 'startTime');
    const end = text(draft, 'endTime');
    const length = eventDuration(start, end, t);
    const duration =
        draft.allDay === true
            ? t('chat.draft.cal_all_day', 'All day event')
            : length
              ? t('chat.draft.cal_duration', 'Duration: {duration}', { duration: length })
              : '';
    const when = start ? `${formatDateTime(start)}${end ? ` → ${formatDateTime(end)}` : ''}` : '';

    return (
        <DraftCardShell
            state={state}
            header={executeHeader(state, label, t('chat.draft.executing', 'Executing...'), t)}
            icon={look.icon}
            tone={look.tone}
            title={text(draft, 'title')}
            titleIcon="Calendar"
            actions={
                <Button
                    label={action === 'delete' ? t('common.delete', 'Delete') : t('chat.draft.confirm', 'Confirm')}
                    iconName="Check"
                    variant={action === 'delete' ? 'danger' : 'primary'}
                    size="sm"
                    loading={state.status === 'working'}
                    onPress={() => state.run(() => executeDraft('calendar', draft))}
                />
            }
        >
            <DraftField icon="Clock" value={when} />
            <DraftField icon="Timer" value={duration} />
            <DraftField icon="MapPin" value={text(draft, 'location')} />
            <DraftField icon="Users" value={attendeesOf(draft).join(', ')} />
            {draft.addGoogleMeet === true ? <DraftField icon="Video" value={t('chat.draft.cal_meet_link', 'Google Meet link will be created')} /> : null}
            {draft.isOnlineMeeting === true ? <DraftField icon="Video" value={t('chat.draft.cal_teams_link', 'Microsoft Teams link will be created')} /> : null}
            <DraftField icon="TextAlignStart" value={text(draft, 'description')} />
            {action === 'delete' && !start ? <DraftField value={t('chat.draft.cal_event_id', 'Event ID: {id}', { id: text(draft, 'eventId') })} /> : null}
        </DraftCardShell>
    );
}
