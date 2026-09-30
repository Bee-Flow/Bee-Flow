/**
 * Blueprint writes: publish, export, install and upgrade. Each refreshes what
 * it changed and hands the result to the screen, which decides what to say.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { shareText } from '@/core/api/shareFile';

import { refreshProject } from './mutations';
import { projectKeys } from '../api/keys';
import {
    applyUpgrade,
    exportSolution,
    installBlueprint,
    publishSolution,
    type InstallSource,
} from '../api/packageEndpoints';
import type { InstallReport, PublishResult, UpgradeReport } from '../model/package';

/** Publish the next version. The gallery and this project's history both move. */
export function usePublishSolution(id: string, onDone?: (result: PublishResult) => void) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: () => publishSolution(id),
        onSuccess: (result) => {
            void queryClient.invalidateQueries({ queryKey: projectKeys.blueprints });
            refreshProject(queryClient, id);
            onDone?.(result);
        },
    });
}

/**
 * Export: the Blueprint file, handed to the share sheet ("save to Files",
 * "send"). The manifest is held only for as long as it takes to write it.
 */
export function useExportSolution(id: string) {
    return useMutation({
        mutationFn: async (fileName: string) => {
            const text = await exportSolution(id);
            await shareText(text, `${fileName}.blueprint.json`);
        },
    });
}

export function useInstallBlueprint(onDone?: (report: InstallReport) => void) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ source, name }: { source: InstallSource; name: string }) => installBlueprint(source, name),
        onSuccess: (report) => {
            void queryClient.invalidateQueries({ queryKey: projectKeys.projects });
            onDone?.(report);
        },
    });
}

export function useApplyUpgrade(id: string, onDone?: (report: UpgradeReport) => void) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (blueprintId: string) => applyUpgrade(id, blueprintId),
        onSuccess: (report) => {
            refreshProject(queryClient, id);
            onDone?.(report);
        },
    });
}
