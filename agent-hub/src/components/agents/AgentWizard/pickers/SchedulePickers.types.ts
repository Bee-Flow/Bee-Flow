/** Typen van de planning-kiezer (SchedulePickers). Alleen types. */

import type { TranslateFn } from '../../../../hooks/useTranslation';

export interface ScheduleRow {
    id: string;
    title?: string | null;
    prompt?: string | null;
    isActive?: boolean;
    nextRunAt?: string | null;
    repeatInterval?: string | null;
    daysOfWeek?: string[] | null;
    timeOfDay?: string | null;
    timezone?: string | null;
}

/** De agent waarvoor een schema gemaakt wordt. */
export interface ScheduleAgent {
    id?: string | null;
    name?: string | null;
}

export interface SchedulesPickerProps {
    t: TranslateFn;
    agent?: ScheduleAgent | null;
    schedules: ScheduleRow[];
    onClose: () => void;
    onCreate: () => void;
    onEdit: (row: ScheduleRow) => void;
    onToggle: (row: ScheduleRow) => void;
    onRunNow: (row: ScheduleRow) => void;
    onDelete: (row: ScheduleRow) => void;
}

export interface ScheduleModalProps {
    t: TranslateFn;
    agent: ScheduleAgent;
    initialSchedule?: ScheduleRow | null;
    onClose: () => void;
    onSaved: () => void;
}
