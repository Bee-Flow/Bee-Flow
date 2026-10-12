/**
 * Keeping React Query's copies in step with what the editor saved.
 *
 * The editor's own row (flowKeys.definition) takes the server's answer at
 * once — the draft store hydrates from it, and ignores it while it holds
 * unsaved edits. The automations feature's copies (the list, the detail
 * screen) are only MARKED stale while editing: an autosave every few seconds
 * must not refetch the list each time. They are refetched when the editor
 * closes (`refreshAutomationViews`).
 */

import type { QueryClient } from '@tanstack/react-query';

import { automationKeys } from '@/features/automations';

import { flowKeys } from '../api/keys';
import type { FlowAutomation } from '../api/types';

type DefinitionData = { automation: FlowAutomation; summary: string } | null | undefined;

/** Put the server's row under the editor's key, keeping the summary it had. */
export function adoptRow(queryClient: QueryClient, row: FlowAutomation | null): void {
    if (!row?.id) return;
    queryClient.setQueryData<DefinitionData>(flowKeys.definition(row.id), (prev) => ({
        automation: row,
        summary: prev?.summary ?? '',
    }));
    void queryClient.invalidateQueries({ queryKey: automationKeys.automation(row.id), refetchType: 'none' });
    void queryClient.invalidateQueries({ queryKey: automationKeys.automations, refetchType: 'none' });
}

/** The automation's list row and detail screen, refetched now (the editor closed, or it was armed). */
export function refreshAutomationViews(queryClient: QueryClient, id: string | null): void {
    if (id) void queryClient.invalidateQueries({ queryKey: automationKeys.automation(id) });
    void queryClient.invalidateQueries({ queryKey: automationKeys.automations });
}

/** A test run produced a run: the run lists that show it. */
export function refreshRunLists(queryClient: QueryClient, id: string): void {
    void queryClient.invalidateQueries({ queryKey: automationKeys.runs(id) });
    void queryClient.invalidateQueries({ queryKey: automationKeys.recentRuns });
    void queryClient.invalidateQueries({ queryKey: automationKeys.activeRuns });
}
