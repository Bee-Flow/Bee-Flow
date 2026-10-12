import { API_BASE, authFetch } from '../../../../utils/helpers';
import Modal from '../../../shared/Modal';

// Schedule delete-confirmation modal (in-app instead of window.confirm so the
// styling, focus management and i18n match the rest of the studio). Subtree
// moved verbatim from BuilderSplit; state stays in the parent.
export default function ScheduleDeleteModal({ t, scheduleDeleteTarget, scheduleDeleting, setScheduleDeleteTarget, setScheduleDeleting, refreshAgentSchedules, mountedRef }) {
    const remove = async () => {
        if (scheduleDeleting) return;
        setScheduleDeleting(true);
        try {
            await authFetch(`${API_BASE}/api/cowork/${scheduleDeleteTarget.id}`, { method: 'DELETE' });
            await refreshAgentSchedules();
        } catch (_) { /* non-fatal */ }
        finally {
            if (mountedRef.current) {
                setScheduleDeleting(false);
                setScheduleDeleteTarget(null);
            }
        }
    };

    return (
        <Modal
            open
            onClose={() => setScheduleDeleteTarget(null)}
            role="alertdialog"
            size="md"
            zIndex={1100}
            disableBackdropClose
            disableEscapeClose={scheduleDeleting}
            title={t('agent_schedules.delete_title', 'Delete schedule')}
            footer={
                <>
                    <button
                        onClick={() => setScheduleDeleteTarget(null)}
                        disabled={scheduleDeleting}
                        className="px-4 py-2 rounded-full text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] disabled:opacity-50"
                    >
                        {t('agent_studio.cancel', 'Cancel')}
                    </button>
                    <button
                        onClick={remove}
                        disabled={scheduleDeleting}
                        className="px-4 py-2 rounded-full text-sm bg-red-500 text-white hover:bg-red-600 disabled:opacity-50"
                    >
                        {scheduleDeleting ? (t('agent_studio.deleting', 'Deleting…')) : (t('agent_studio.delete', 'Delete'))}
                    </button>
                </>
            }
        >
            <div className="text-sm text-[var(--text-secondary)]">
                {(t('agent_schedules.delete_body', 'Delete "{title}"?')).replace('{title}', scheduleDeleteTarget.title || '')}
            </div>
        </Modal>
    );
}
