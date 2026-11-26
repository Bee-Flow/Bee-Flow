import { useState } from 'react';
import type { CoworkItem } from '@/api/cowork.types';
import type { ClockProposal } from '@/api/coworkProposals';
import type { useCoworkItemActions } from '@/api/coworkTask';
import type { TranslateFn } from '@/hooks/useTranslation';
import { cadenceLine } from '../coworkSchedule';

function currentClock(item: CoworkItem) {
    return JSON.stringify([item.id, item.triggerKind, item.repeatInterval, item.daysOfWeek, item.timeOfDay, item.timezone, item.nextRunAt]);
}

export default function useConversationClock(item: CoworkItem, live: boolean, update: ReturnType<typeof useCoworkItemActions>['change'], setReply: (line: string) => void, t: TranslateFn) {
    const [draft, setDraft] = useState<{ before: string; schedule: ClockProposal } | null>(null);
    const cancel = () => setDraft(null);
    const propose = (schedule: ClockProposal) => {
        setReply('');
        setDraft({ before: currentClock(item), schedule });
    };
    const confirm = () => {
        if (!draft || live || update.isPending) return;
        if (currentClock(item) !== draft.before || Date.parse(draft.schedule.nextRunAt) <= Date.now()) {
            cancel();
            setReply(t('cowork_task.orb.refresh_clock', 'The schedule changed. Ask me for the new time again.'));
            return;
        }
        update.mutate(draft.schedule, { onSuccess: () => {
            cancel();
            setReply(t('cowork_task.edit.saved', 'Saved') + ' · ' + cadenceLine(draft.schedule, t) + ' · ' + draft.schedule.timezone);
        } });
    };
    return { schedule: draft?.schedule, propose, cancel, confirm, disabled: live || update.isPending };
}
