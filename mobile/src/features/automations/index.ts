/**
 * The automations feature's public surface: the screens app/ renders, and the
 * run vocabulary (status, rows, the live feed, step names, a value drawn
 * readably) the other Automate features share. Import from
 * '@/features/automations', never from its internals.
 */

export { AutomationDetailScreen } from './screens/AutomationDetailScreen';
export { AutomationsScreen } from './screens/AutomationsScreen';
export { RunsScreen } from './screens/RunsScreen';

export { DeleteAutomationSheet } from './components/DeleteAutomationSheet';
export { RunRow } from './components/RunRow';
export { StatusIcon } from './components/StatusPill';
export { RawToggle } from './components/RawToggle';
export { ValuePreview } from './components/ValuePreview';

export {
    getAutomation,
    getAutomationCounts,
    listAutomations,
    publishAutomation,
    runAutomation,
    setAutomationActive,
    updateAutomation,
    type RunInput,
} from './api/endpoints';
export { createAutomation, deleteAutomation, getAutomationUsage, readCreateResult } from './api/lifecycle';
export { issueDetailsOf, readIssues } from './api/issues';
export { automationKeys } from './api/keys';
export { readAutomation, readRun, readRunStep } from './api/readers';
export { useActiveRuns, useAutomations, useRecentRuns, useSchedulePreview } from './hooks/queries';
export { useCancelRun, useRunListsRefresh, type MutationHandlers } from './hooks/mutations';
export { useAutomationUsage, useCreateAutomation, useDeleteAutomation } from './hooks/lifecycle';
export { useRunStream } from './hooks/useRunStream';

export { isLiveStatus, statusLabel, statusToken } from './model/status';
export { absoluteTime, formatDuration } from './model/time';
export { errorClassText, errorClassWords, triggerText, triggerWords, type Words } from './model/runWords';
export { describeTrigger, triggerIcon } from './model/trigger';
export { pad } from './model/cron';
export { describeValue, isProse, previewValue } from './model/values';
export { buildNameMap, friendlyStepName, nameFor } from './model/stepLabels';
export type {
    ActiveRun,
    Automation,
    AutomationCounts,
    AutomationDefinition,
    AutomationIssue,
    AutomationPatch,
    AutomationRun,
    AutomationRunStep,
    AutomationSaveResult,
    AutomationUsage,
    AutomationUsageRow,
    CreateAutomationBody,
    CreateAutomationResult,
    RunEvent,
    RunStatus,
    RunTriggerResult,
    SchedulePreview,
} from './model/types';
