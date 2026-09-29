import { API_BASE, authFetch } from '../../../../utils/helpers';
import Modal from '../../../shared/Modal';

// Routine delete-confirmation modal (in-app instead of window.confirm so the
// styling, focus management and i18n match the rest of the studio). Subtree
// moved verbatim from BuilderSplit; state stays in the parent.
export default function RoutineDeleteModal({ t, routineDeleteTarget, routineDeleting, setRoutineDeleteTarget, setRoutineDeleting, refreshAgentRoutines, mountedRef }) {
    const remove = async () => {
        if (routineDeleting) return;
        setRoutineDeleting(true);
        try {
            await authFetch(`${API_BASE}/api/ai-tasks/${routineDeleteTarget.id}`, { method: 'DELETE' });
            await refreshAgentRoutines();
        } catch (_) { /* non-fatal */ }
        finally {
            if (mountedRef.current) {
                setRoutineDeleting(false);
                setRoutineDeleteTarget(null);
            }
        }
    };

    return (
        <Modal
            open
            onClose={() => setRoutineDeleteTarget(null)}
            role="alertdialog"
            size="md"
            zIndex={1100}
            disableBackdropClose
            disableEscapeClose={routineDeleting}
            title={t('routines.delete_title', 'Delete routine')}
            footer={
                <>
                    <button
                        onClick={() => setRoutineDeleteTarget(null)}
                        disabled={routineDeleting}
                        className="px-4 py-2 rounded-full text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] disabled:opacity-50"
                    >
                        {t('agent_studio.cancel', 'Cancel')}
                    </button>
                    <button
                        onClick={remove}
                        disabled={routineDeleting}
                        className="px-4 py-2 rounded-full text-sm bg-red-500 text-white hover:bg-red-600 disabled:opacity-50"
                    >
                        {routineDeleting ? (t('agent_studio.deleting', 'Deleting…')) : (t('agent_studio.delete', 'Delete'))}
                    </button>
                </>
            }
        >
            <div className="text-sm text-[var(--text-secondary)]">
                {(t('routines.delete_body', 'Delete "{title}"?')).replace('{title}', routineDeleteTarget.title || '')}
            </div>
        </Modal>
    );
}
