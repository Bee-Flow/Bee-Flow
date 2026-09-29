import Modal from '../../../shared/Modal';

// Confirmation modal shown before flipping `embedEnabled` to true. Without
// this, the toggle silently makes the agent reachable at the public
// /chat/<id> URL — users may not realise that's what just happened.
export default function EnableEmbedConfirmModal({ t, agent, onConfirm, onCancel }) {
    const url = agent?.id ? `${window.location.origin}/chat/${agent.id}` : '';
    return (
        <Modal
            open
            onClose={onCancel}
            role="alertdialog"
            size="md"
            zIndex={1100}
            title={t('agent_wizard.embed.confirm_title', 'Make this agent public?')}
            footer={
                <>
                    <button onClick={onCancel} className="px-4 py-2 rounded-full text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] transition">
                        {t('agent_wizard.embed.confirm_cancel', 'Cancel')}
                    </button>
                    <button onClick={onConfirm} className="px-4 py-2 rounded-full text-sm bg-[var(--text-primary)] text-[var(--bg-primary)] hover:opacity-90 transition">
                        {t('agent_wizard.embed.confirm_enable', 'Enable public access')}
                    </button>
                </>
            }
        >
            <div className="text-sm text-[var(--text-secondary)] space-y-3">
                <p>{t('agent_wizard.embed.confirm_body', 'Anyone who knows the URL will be able to chat with this agent without an account. The agent will run with its full configuration: system prompt, attached skills, and knowledge bases.')}</p>
                {url && (
                    <div className="text-xs px-3 py-2 rounded-lg bg-[var(--bg-secondary)] text-[var(--text-tertiary)] break-all font-mono">{url}</div>
                )}
            </div>
        </Modal>
    );
}
