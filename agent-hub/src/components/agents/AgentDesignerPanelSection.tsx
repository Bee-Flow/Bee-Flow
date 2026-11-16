import React from 'react';
import type { AgentFormData } from './AgentEditorUI';
import { TranslateParams } from '../../hooks/useTranslation';
import type { PanelAgent } from './AgentDesignerPanel.types';
import Button from '@/components/shared/Button';

/** The footer of the agent panel: delete and publish on the left, cancel and save on the right. Theme tokens only. */
export function AgentDesignerPanelSection({ agent, handleDelete, t, togglePublish, formData, onClose, saveAgent, saving }: { agent: PanelAgent | null | undefined; handleDelete: () => Promise<void>; t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; togglePublish: () => Promise<void>; formData: AgentFormData; onClose: React.MouseEventHandler<HTMLButtonElement>; saveAgent: () => Promise<void>; saving: boolean; }) {
    return <div className="px-4 py-3 border-t flex items-center justify-between border-[var(--border-default)] bg-[var(--bg-secondary)]">
        <div className="flex items-center gap-2">
            {agent && (
                <>
                    <Button variant="danger" onClick={() => { void handleDelete(); }} data-testid="agent-delete-btn">
                        {t('common.delete')}
                    </Button>
                    <Button variant={formData.isPublished ? 'success' : 'secondary'} onClick={() => { void togglePublish(); }} aria-pressed={!!formData.isPublished}>
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                            {formData.isPublished ? (
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                            ) : (
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
                            )}
                        </svg>
                        {formData.isPublished ? t('agent.published') : t('agent.publish')}
                    </Button>
                </>
            )}
        </div>
        <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onClose}>
                {t('common.cancel')}
            </Button>
            <Button
                variant="primary"
                onClick={() => { void saveAgent(); }}
                disabled={saving || !formData.name.trim()}
                data-testid="agent-save-btn"
            >
                {saving ? t('agent.saving') : agent ? t('agent.save_changes') : t('agent.create_agent')}
            </Button>
        </div>
    </div>;
}
