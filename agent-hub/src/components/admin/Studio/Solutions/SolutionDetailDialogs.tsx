import React from 'react';
import SolutionAccessDialog, { type SolutionRole } from './SolutionAccessDialog';
import SolutionExportDialog from './SolutionExportDialog';
import UpgradeDialog from './upgradeClient';

/**
 * The three dialogs a Dev Solution opens from its header (access, export or
 * publish, upgrade). Only one is open at a time; `dialog` names it. Split out
 * of SolutionDetail so that file stays the screen and nothing else.
 */

export type DialogName = 'export' | 'publish' | 'upgrade' | 'access' | null;

export interface SolutionDetailDialogsProps {
    dialog: DialogName;
    setDialog: (next: DialogName) => void;
    project: { id: string };
    name: string;
    role: SolutionRole;
    currentUserId?: string | null;
    completeness: unknown;
    availability: { blueprintId?: string | null; latestVersion?: number | string | null };
    onBack: () => void;
    refresh: Record<'fetchMembers' | 'fetchBlueprints' | 'fetchReleases' | 'fetchResources' | 'fetchGraph' | 'fetchCompleteness', () => void>;
}

export default function SolutionDetailDialogs({
    dialog, setDialog, project, name, role, currentUserId, completeness, availability, onBack, refresh,
}: SolutionDetailDialogsProps) {
    return (
        <>
            {/* The audience capsule reads the member list, so it is re-read
                when the dialog closes. Leaving the Solution from the panel
                ends access to all of it: back to the overview, which
                re-reads the list without it. */}
            <SolutionAccessDialog
                open={dialog === 'access'}
                onClose={() => { setDialog(null); refresh.fetchMembers(); }}
                onLeft={() => { setDialog(null); onBack(); }}
                projectId={project.id}
                projectName={name}
                role={role}
                currentUserId={currentUserId || null}
            />

            <SolutionExportDialog
                open={dialog === 'export' || dialog === 'publish'}
                onClose={() => { setDialog(null); refresh.fetchBlueprints(); refresh.fetchReleases(); }}
                projectId={project.id}
                projectName={name}
                role={role}
                mode={dialog === 'publish' ? 'publish' : 'export'}
                completeness={completeness}
            />

            {/* `blueprintId` comes from `availability`, and is only filled when
                the Blueprint was found in the org-scoped list, so no plan can be
                asked for an id that did not pass the scope. The server checks
                again: the call sends the id, never a manifest. */}
            <UpgradeDialog
                open={dialog === 'upgrade'}
                onClose={() => setDialog(null)}
                projectId={project.id}
                blueprintId={availability.blueprintId as null | undefined}
                latestVersion={availability.latestVersion as null | undefined}
                onDone={() => {
                    refresh.fetchResources();
                    refresh.fetchGraph();
                    refresh.fetchCompleteness();
                }}
            />
        </>
    );
}
