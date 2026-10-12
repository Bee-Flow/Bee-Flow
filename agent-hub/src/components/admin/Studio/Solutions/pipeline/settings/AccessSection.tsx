import React, { useState } from 'react';
import { useTranslation } from '../../../../../../hooks/useTranslation';
import Button from '../../../../../shared/Button';
import SolutionAccessDialog, { type SolutionRole } from '../../SolutionAccessDialog';

/**
 * Who may open and operate this stage, and as whom it runs (design 4.3).
 *
 * Access is the membership of the STAGE project, never inherited from Dev: the
 * same members dialog as the Solution's, opened on the stage's own project id.
 * The run-as person is read-only here. It is the Solution owner's identity, whose
 * connections the stage's automations use, and it only changes by removing the
 * stage and setting it up again.
 */

export interface AccessSectionProps {
    stageProjectId: string;
    stageName: string;
    role: string;
    runAs: { userId: string | null; name: string | null };
    currentUserId: string | null;
    onLeft: () => void;
}

const asRole = (role: string): SolutionRole => (role === 'owner' || role === 'editor' ? role : 'viewer');

export default function AccessSection({ stageProjectId, stageName, role, runAs, currentUserId, onLeft }: AccessSectionProps) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    return (
        <div className="space-y-3" data-testid="settings-access">
            <div className="rounded-lg px-3 py-2 bg-[var(--bg-secondary)]" data-testid="access-run-as">
                <p className="text-[11px] uppercase tracking-wide text-[var(--text-tertiary)]">{t('stage_settings.run_as', 'Runs as')}</p>
                <p className="text-sm text-[var(--text-primary)]">
                    {runAs.name || runAs.userId || t('stage_settings.run_as_unknown', 'Unknown')}
                </p>
                <p className="text-xs text-[var(--text-tertiary)]">
                    {t('stage_settings.run_as_hint', 'The automations of this stage use this person\'s accounts. It cannot be changed here.')}
                </p>
            </div>
            <Button size="sm" variant="secondary" onClick={() => setOpen(true)} data-testid="access-open">
                {t('stage_settings.access_manage', 'Who can open this stage')}
            </Button>
            <SolutionAccessDialog
                open={open} onClose={() => setOpen(false)} projectId={stageProjectId} projectName={stageName}
                role={asRole(role)} currentUserId={currentUserId} onLeft={() => { setOpen(false); onLeft(); }}
            />
        </div>
    );
}
