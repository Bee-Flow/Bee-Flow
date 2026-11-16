// The Direct chat page of AI configuration: how a direct chat behaves. The
// system prompt and the cap on tool-call rounds are one form with one footer;
// below them, the tools each tier may call (read-only). The page header comes
// from the dashboard frame (AdminPage).
import React, { useMemo, useState } from 'react';
import DirectChatToolsMatrix from './DirectChatToolsMatrix';
import { useAiConfigQuery } from '@/api/queries/aiConfigRead';
import { useDirectChatPrompt } from '@/api/queries/orgAdminReads';
import { ApiError } from '@/api/mutate';
import { apiRequest } from '@/api/typedRequest';
import SaveFooter from '@/components/shared/SaveFooter';
import { FIELD_INPUT, Field, SettingBlock, SettingRow, SettingsGroup, SettingsList } from '@/components/shared/SettingsList';
import toast from '@/components/shared/Toast';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';
import { logger } from '@/utils/logger';

/** The keys of GET /ai/config this page reads. */
interface RoundsRead {
    maxToolRoundsChat?: number | string | null;
    /** What each chat surface runs with while the cap is empty (core/llm/toolRoundDefaults.mts). */
    toolRoundDefaults?: Partial<Record<'directChat' | 'notebookChat' | 'webpageChat' | 'nativeLoop', number>>;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/** The per-surface defaults as the server reports them; a surface it does not name is left out. */
function SurfaceDefaults({ t, defaults }: { t: TranslateFn; defaults: RoundsRead['toolRoundDefaults'] }) {
    const surfaces = [
        { id: 'directChat', name: t('admin_ai_config.limits_surface_direct', 'Direct chat') },
        { id: 'notebookChat', name: t('admin_ai_config.limits_surface_notebook', 'Notebook chat') },
        { id: 'webpageChat', name: t('admin_ai_config.limits_surface_webpage', 'Webpage chat') },
        { id: 'nativeLoop', name: t('admin_ai_config.limits_surface_native', 'Native streaming loop') },
    ] as const;
    const known = surfaces.filter(s => typeof defaults?.[s.id] === 'number');
    if (known.length === 0) return null;
    return (
        <Field label={t('admin_ai_config.limits_surface_title', 'Per-surface defaults (when empty)')}>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                {known.map(s => (
                    <div key={s.id} className="rounded-md border border-[var(--border-default)] bg-[var(--bg-primary)] px-3 py-2 text-xs">
                        <div className="text-[var(--text-tertiary)]">{s.name}</div>
                        <div className="mt-0.5 font-semibold text-[var(--text-primary)]">{defaults?.[s.id]} {t('admin_ai_config.limits_rounds_unit', 'rounds')}</div>
                    </div>
                ))}
            </div>
        </Field>
    );
}

/** The cap on tool-call rounds per turn, with what each surface runs with while it is empty. */
function ToolRoundsRow({ value, onChange, defaults }: { value: string; onChange: (next: string) => void; defaults: RoundsRead['toolRoundDefaults'] }) {
    const { t } = useTranslation();
    return (
        <SettingRow
            htmlFor="direct-chat-rounds"
            label={t('admin_ai_config.limits_rounds_title', 'Tool calls per chat turn')}
            hint={t('ai_model_setup.direct_rounds_hint', 'How many rounds of tool calls a turn may take before the model must answer. The cap also applies to notebook chat, webpage chat and the native streaming loop. Leave empty for each one\'s default.')}
            expanded={<SurfaceDefaults t={t} defaults={defaults} />}
        >
            <input
                id="direct-chat-rounds"
                type="number"
                min="1"
                max="50"
                value={value}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
                placeholder={t('admin_ai_config.limits_rounds_placeholder', 'Use per-surface defaults')}
                title={t('admin_ai_config.limits_rounds_range', 'Range 1 to 50. Leave empty to use per-surface defaults.')}
                className={FIELD_INPUT}
            />
        </SettingRow>
    );
}

/**
 * POST, true when the server took it. A refusal (ApiError) and a request that
 * never reached the server (offline: a TypeError from fetch) both read as not
 * stored, so the footer leaves "Saving…" and offers a retry.
 */
async function stored(pending: Promise<unknown>): Promise<boolean> {
    try {
        await pending;
        return true;
    } catch (err) {
        if (!(err instanceof ApiError)) logger.warn('DirectChatConfig: save did not reach the server', err);
        return false;
    }
}

const DirectChatConfig = () => {
    const { t } = useTranslation();
    const { prompt: storedPrompt, loading, markStored } = useDirectChatPrompt();
    const aiConfig = useAiConfigQuery<RoundsRead>();
    const storedRounds = useMemo(() => String(aiConfig.data?.config?.maxToolRoundsChat ?? ''), [aiConfig.data]);
    // null until the admin types: the field shows what is stored, an edit replaces it.
    const [promptDraft, setPromptDraft] = useState<string | null>(null);
    const [roundsDraft, setRoundsDraft] = useState<string | null>(null);
    const systemPrompt = promptDraft ?? storedPrompt;
    const rounds = roundsDraft ?? storedRounds;
    const promptDirty = promptDraft !== null && promptDraft !== storedPrompt;
    const roundsDirty = roundsDraft !== null && roundsDraft.trim() !== storedRounds;
    const [saveState, setSaveState] = useState<SaveState>('idle');
    const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);

    const handleSave = async () => {
        setSaveState('saving');
        const trimmed = rounds.trim();
        const results = await Promise.all([
            promptDirty ? stored(apiRequest('POST /ai/config/direct-chat', { body: { systemPrompt } })) : Promise.resolve(true),
            roundsDirty ? stored(apiRequest('POST /ai/config', { body: { maxToolRoundsChat: trimmed === '' ? null : parseInt(trimmed, 10) } })) : Promise.resolve(true),
        ]);
        if (results.every(Boolean)) {
            setSaveState('saved');
            setLastSavedAt(new Date());
            toast.success(t('ai_model_setup.direct_saved', 'Direct chat settings saved'));
        } else {
            setSaveState('error');
            toast.error(t('admin_ai_config.direct_save_failed', 'Failed to save'));
        }
        // What was stored leaves the draft; a part that failed stays edited.
        if (results[0] && promptDirty) {
            markStored(systemPrompt);
            setPromptDraft(null);
        }
        if (results[1] && roundsDirty) {
            await aiConfig.refetch();
            setRoundsDraft(null);
        }
    };

    if (loading || aiConfig.isPending) return <div className="p-4 text-sm text-[var(--text-tertiary)]">{t('admin_ai_config.loading', 'Loading...')}</div>;

    return (
        <div className="flex flex-col gap-8">
            <SettingsGroup title={t('ai_model_setup.direct_behaviour_title', 'Behaviour')}>
                <SettingsList>
                    <SettingBlock
                        label={t('admin_ai_config.direct_prompt_label', 'System Prompt')}
                        htmlFor="direct-chat-prompt"
                        hint={t('admin_ai_config.direct_prompt_hint', 'This prompt defines the AI personality for Direct Chat. The current date and available tools are appended automatically. Leave empty to use the default.')}
                    >
                        <textarea
                            id="direct-chat-prompt"
                            value={systemPrompt}
                            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setPromptDraft(e.target.value)}
                            placeholder={t('admin_ai_config.direct_prompt_placeholder', 'You are a helpful AI assistant. Respond thoughtfully and concisely.')}
                            rows={8}
                            className={`${FIELD_INPUT} min-h-[120px] resize-y font-mono leading-relaxed`}
                        />
                    </SettingBlock>
                    <ToolRoundsRow value={rounds} onChange={setRoundsDraft} defaults={aiConfig.data?.config?.toolRoundDefaults} />
                </SettingsList>
                <SaveFooter
                    onSave={() => { void handleSave(); }}
                    onCancel={promptDirty || roundsDirty ? () => { setPromptDraft(null); setRoundsDraft(null); } : undefined}
                    saving={saveState === 'saving'}
                    dirty={promptDirty || roundsDirty}
                    saveState={saveState}
                    lastSavedAt={lastSavedAt}
                    onRetry={() => { void handleSave(); }}
                />
            </SettingsGroup>
            <DirectChatToolsMatrix />
        </div>
    );
};

export default DirectChatConfig;
