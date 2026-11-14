import React, { useState } from 'react';
import SectionHeader from '@/components/shared/SectionHeader';
import { FIELD_INPUT, SAVE_BUTTON, SettingBlock, SettingsList } from '@/components/shared/SettingsList';
import { useToastOnMessage } from './ui/useToastOnMessage';
import { useDirectChatPrompt } from '@/api/queries/orgAdminReads';
import { useTranslation } from '@/hooks/useTranslation';
import type { StatusMessage } from './chatModelTiers/tierTypes';
import { ApiError } from '@/api/mutate';
import { apiRequest } from '@/api/typedRequest';

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
            const res = await apiRequest('POST /ai/config/direct-chat', { body: { systemPrompt } }).catch((err: unknown) => {
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

    useToastOnMessage(message);
    if (loading) return <div className="text-sm p-4 text-[var(--text-muted)]">{t('admin_ai_config.loading', 'Loading...')}</div>;

    return (
        <div className="flex max-w-4xl flex-col gap-6">
            <SectionHeader
                title={t('admin_ai_config.direct_title', 'Direct Chat Settings')}
                description={t('admin_ai_config.direct_subtitle', 'Configure the system prompt for Direct Chat')}
            />
            <SettingsList>
                <SettingBlock
                    label={t('admin_ai_config.direct_prompt_label', 'System Prompt')}
                    htmlFor="direct-chat-prompt"
                    hint={t('admin_ai_config.direct_prompt_hint', 'This prompt defines the AI personality for Direct Chat. The current date and available tools are appended automatically. Leave empty to use the default.')}
                >
                    <textarea
                        id="direct-chat-prompt"
                        value={systemPrompt}
                        onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setDraft(e.target.value)}
                        placeholder={t('admin_ai_config.direct_prompt_placeholder', 'You are a helpful AI assistant. Respond thoughtfully and concisely.')}
                        rows={8}
                        className={`${FIELD_INPUT} min-h-[120px] resize-y font-mono leading-relaxed`}
                    />
                </SettingBlock>
            </SettingsList>
            <div>
                <button type="button" onClick={handleSave} disabled={saving} className={SAVE_BUTTON}>
                    {saving ? t('admin_ai_config.saving', 'Saving...') : t('admin_ai_config.direct_save', 'Save System Prompt')}
                </button>
            </div>
        </div>
    );
};

export default DirectChatConfig;
