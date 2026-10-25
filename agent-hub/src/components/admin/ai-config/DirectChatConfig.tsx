import React, { useState } from 'react';
import { API_BASE } from '../../../utils/helpers';
import { useDirectChatPrompt } from '../../../api/queries/orgAdminReads';
import { useTranslation } from '../../../hooks/useTranslation';
import type { StatusMessage } from './chatModelTiers/tierTypes';
import { mutate, ApiError } from '../../../api/mutate';

const DirectChatConfig = () => {
    const { t } = useTranslation();
    const { prompt: loadedPrompt, loading } = useDirectChatPrompt();
    // null until the admin types: the field shows the loaded prompt, an edit replaces it.
    const [draft, setDraft] = useState<string | null>(null);
    const systemPrompt = draft ?? loadedPrompt;
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState<StatusMessage | null>(null);

    const handleSave = async () => {
        setSaving(true);
        try {
            const res = await mutate(`${API_BASE}/ai/config/direct-chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ systemPrompt })
            }).catch((err: unknown) => {
                if (err instanceof ApiError) return null;
                throw err;
            });
            if (res) {
                setMessage({ type: 'success', text: t('admin_ai_config.direct_saved', 'System prompt saved!') });
            } else {
                setMessage({ type: 'error', text: t('admin_ai_config.direct_save_failed', 'Failed to save') });
            }
        } catch (e) {
            setMessage({ type: 'error', text: t('admin_ai_config.direct_save_failed', 'Failed to save') });
        } finally {
            setSaving(false);
            setTimeout(() => setMessage(null), 3000);
        }
    };

    if (loading) return <div className="text-sm p-4 text-[var(--text-muted)]">{t('admin_ai_config.loading', 'Loading...')}</div>;

    return (
        <div className="p-6 rounded-xl border bg-[var(--bg-secondary)] border-[var(--border-default)]">
            <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-4">
                    <div className="w-12 h-12 rounded-xl flex items-center justify-center text-2xl [background:rgba(99,102,241,0.15)]">
                        💬
                    </div>
                    <div>
                        <h3 className="text-lg font-semibold text-[var(--text-primary)]">{t('admin_ai_config.direct_title', 'Direct Chat Settings')}</h3>
                        <p className="text-sm text-[var(--text-muted)]">{t('admin_ai_config.direct_subtitle', 'Configure the system prompt for Direct Chat')}</p>
                    </div>
                </div>
                {message && (
                    <span className={`text-sm ${message.type === 'success' ? 'text-green-500' : 'text-red-500'}`}>
                        {message.text}
                    </span>
                )}
            </div>

            <div className="space-y-4 max-w-3xl">
                <div>
                    <label className="block text-sm font-medium mb-2 text-[var(--text-primary)]">{t('admin_ai_config.direct_prompt_label', 'System Prompt')}</label>
                    <textarea
                        value={systemPrompt}
                        onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setDraft(e.target.value)}
                        placeholder={t('admin_ai_config.direct_prompt_placeholder', 'You are a helpful AI assistant. Respond thoughtfully and concisely.')}
                        rows={8}
                        className="w-full px-4 py-3 rounded-lg border outline-none focus:border-[var(--accent-primary)] resize-y font-mono text-sm leading-relaxed [background:var(--bg-tertiary)] [border-color:var(--border-default)]! [color:var(--text-primary)]! min-h-[120px]"
                    />
                    <p className="text-xs mt-1.5 text-[var(--text-muted)]">
                        {t('admin_ai_config.direct_prompt_hint', 'This prompt defines the AI personality for Direct Chat. The current date and available tools are appended automatically. Leave empty to use the default.')}
                    </p>
                </div>

                <div className="pt-2">
                    <button
                        onClick={handleSave}
                        disabled={saving}
                        className="px-6 py-2.5 rounded-xl font-medium text-white transition-all disabled:opacity-50 bg-[var(--accent-primary)]"
                    >
                        {saving ? t('admin_ai_config.saving', 'Saving...') : t('admin_ai_config.direct_save', 'Save System Prompt')}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default DirectChatConfig;
