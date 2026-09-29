import Modal from '../../shared/Modal';

/**
 * Shown when a save returns 409 (the agent changed elsewhere — another tab, a
 * version restore, a publish). Mirrors AppStudio's conflict reconcile: the user
 * either takes the server's copy (discarding local edits) or overwrites with
 * their own. There is no undo stack in the agent editor, so "load latest"
 * discards unsaved changes — the copy says so explicitly.
 */
export default function AgentConflictModal({ t, busy, onLoadLatest, onOverwrite, onDismiss }) {
    return (
        <Modal
            open
            onClose={onDismiss}
            role="alertdialog"
            size="md"
            zIndex={1200}
            disableBackdropClose={busy}
            disableEscapeClose={busy}
            title={t('agent_wizard.conflict.title', 'This agent changed elsewhere')}
            footer={
                <>
                    <button
                        onClick={onDismiss}
                        disabled={busy}
                        className="px-4 py-2 rounded-full text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] disabled:opacity-50"
                    >
                        {t('agent_studio.cancel', 'Cancel')}
                    </button>
                    <button
                        onClick={onLoadLatest}
                        disabled={busy}
                        className="px-4 py-2 rounded-full text-sm border border-[var(--border-default)] text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] disabled:opacity-50"
                    >
                        {t('agent_wizard.conflict.load_latest', 'Load latest')}
                    </button>
                    <button
                        onClick={onOverwrite}
                        disabled={busy}
                        className="px-4 py-2 rounded-full text-sm bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-50"
                    >
                        {busy
                            ? t('agent_wizard.builder.saving', 'Saving…')
                            : t('agent_wizard.conflict.overwrite', 'Keep mine')}
                    </button>
                </>
            }
        >
            <div className="text-sm text-[var(--text-secondary)] space-y-2">
                <p>{t('agent_wizard.conflict.body', 'Someone (or another tab) saved this agent since you opened it. Choose how to continue:')}</p>
                <ul className="list-disc pl-5 space-y-1 text-[13px]">
                    <li>{t('agent_wizard.conflict.load_latest_hint', 'Load latest — take the other version. Your unsaved changes in this tab are discarded.')}</li>
                    <li>{t('agent_wizard.conflict.overwrite_hint', 'Keep mine — overwrite with your version.')}</li>
                </ul>
            </div>
        </Modal>
    );
}
