/** The schedule picker in a sheet, saving through the automation's definition. */

import React from 'react';

import { describeError } from '@/core/api/errors';
import { Banner, Sheet, useToast } from '@/shared/ui';

import { SchedulePicker } from './SchedulePicker';
import { useSaveSchedule } from '../hooks/mutations';
import type { Automation } from '../model/types';

export function ScheduleSheet({
    id,
    visible,
    automation,
    onClose,
}: {
    /** The route's id — what the save and its invalidation are keyed by. */
    id: string;
    visible: boolean;
    automation: Automation;
    onClose: () => void;
}) {
    const { toast } = useToast();
    const mutation = useSaveSchedule(id, automation, {
        onSuccess: () => {
            onClose();
            toast('Schedule saved', 'success');
        },
    });

    return (
        <Sheet
            visible={visible}
            onClose={onClose}
            title="Schedule"
            subtitle={automation.title || undefined}
        >
            <SchedulePicker
                cron={automation.scheduleCron}
                tz={automation.scheduleTz || Intl.DateTimeFormat().resolvedOptions().timeZone}
                saving={mutation.isPending}
                onSave={(cron) => mutation.mutate(cron)}
            />
            {mutation.isError ? (
                <Banner tone="error">{describeError(mutation.error).message}</Banner>
            ) : null}
        </Sheet>
    );
}
