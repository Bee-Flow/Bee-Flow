import { Loader2 } from 'lucide-react';
import React, { Suspense } from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { lazy } from '../../../../utils/lazyWithReload';
import Modal from '../../../shared/Modal';

/**
 * Who can open this Solution, and with which role.
 *
 * A Solution keeps the same membership model as a project workspace (owner,
 * editors, viewers; users or groups), so the members panel is the one the
 * workspace uses — rendered here in a dialog rather than behind a link to
 * /app/projects, which no longer lists Solutions at all. The panel owns every
 * rule (only the owner invites, changes roles or removes; anyone can leave)
 * and every request; the server enforces the same rules again.
 *
 * Loaded lazily: the dialog is opened rarely, and the panel pulls in the
 * people and group pickers.
 */
const ProjectMembersPanel = lazy(() => import('../../../projects/workspace/ProjectMembersPanel'));

export type SolutionRole = 'owner' | 'editor' | 'viewer';

export interface SolutionAccessDialogProps {
    open: boolean;
    onClose: () => void;
    projectId: string;
    projectName: string;
    role: SolutionRole;
    currentUserId: string | null;
    /**
     * The caller left the Solution from the panel ("Leave"). They can no
     * longer open it, so the page behind the dialog has to go too.
     */
    onLeft: () => void;
}

export default function SolutionAccessDialog({
    open, onClose, projectId, projectName, role, currentUserId, onLeft,
}: SolutionAccessDialogProps) {
    const { t } = useTranslation();
    return (
        <Modal
            open={open}
            onClose={onClose}
            size="lg"
            title={t('solutions.access_title', 'Who can open {name}', { name: projectName })}
            description={t('solutions.access_intro', 'Members can open this Solution in Studio. Editors can change what it holds; only the owner can publish it or change who has access.')}
        >
            <div data-testid="solution-access-dialog">
                {open && (
                    <Suspense
                        fallback={(
                            <div className="flex items-center justify-center py-10 text-[var(--text-tertiary)]">
                                <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" />
                                <span className="sr-only">{t('solutions.access_loading', 'Loading members…')}</span>
                            </div>
                        )}
                    >
                        <ProjectMembersPanel projectId={projectId} role={role} currentUserId={currentUserId} onLeft={onLeft} />
                    </Suspense>
                )}
            </div>
        </Modal>
    );
}
