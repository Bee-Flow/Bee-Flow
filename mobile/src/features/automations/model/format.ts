/**
 * Presentation helpers for the Automate tab, one module per topic: the status
 * vocabulary (status.ts), times and durations (time.ts), triggers
 * (trigger.ts), the cron dialect a phone may edit (cron.ts) and step values
 * (values.ts). This file only gathers them, so a screen imports one place.
 */

export {
    SKIP_REASONS,
    isLiveStatus,
    skipGroupOfStep,
    statusLabel,
    statusToken,
    tokenForSkip,
    tokenForStep,
    type RunStepLike,
    type SkipGroup,
    type StatusTone,
    type StatusToken,
} from './status';
export { absoluteTime, formatDuration, runElapsedMs } from './time';
export { describeTrigger, triggerIcon } from './trigger';
export {
    DEFAULT_SIMPLE_SCHEDULE,
    WEEKDAY_NAMES,
    cronFromSimple,
    describeCron,
    pad,
    simpleFromCron,
    type SimpleSchedule,
    type SimpleScheduleKind,
} from './cron';
export {
    MAX_PREVIEW_COLUMNS,
    MAX_PREVIEW_ROWS,
    describeValue,
    isProse,
    previewValue,
    type CellWords,
    type ValueShape,
} from './values';
