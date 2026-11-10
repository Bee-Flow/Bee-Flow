import { useCallback, useEffect, useRef, useState } from 'react';
import { Save, Sparkles, AlertTriangle, Send } from 'lucide-react';
import AgentEditorUI from '../agents/AgentEditorUI';
import MarkdownRenderer from '../renderers/MarkdownRenderer';
import { tierLabel } from '../licensing/tierMeta';
import { API_BASE } from '../../utils/helpers';
import SupportSlaPoliciesTab from './tabs/SupportSlaPoliciesTab';
import SupportCannedResponsesTab from './tabs/SupportCannedResponsesTab';
import SupportTagsTab from './tabs/SupportTagsTab';
import SupportInsightsTab from './tabs/SupportInsightsTab';
import SupportToolsTab from './tabs/SupportToolsTab';
import { useTranslation } from '../../hooks/useTranslation';
import type { ModelTierMap } from '../../api/queries/modelTiers';
import type { SupportAgentRow, SupportAgentData, PreviewReply } from './SupportAIConfig.types';
import { useConfigTiersForUser } from '../../api/queries/configModels';
import { request, errorBody, RefusedError, mutate } from '../../api/mutate';
import StudioShell from '@/components/shared/StudioShell';
import SectionNav from '@/components/shared/SectionNav';
import { FIELD_INPUT } from '@/components/shared/SettingsList';
import { ALERT_ERROR, CARD, CHIP, CHIP_WARNING, EYEBROW, PRIMARY_BTN } from '@/components/mcpLibrary/ui';

function deriveAgentData(agent: SupportAgentRow | null | undefined): SupportAgentData | null {
    if (!agent) return null;
    let starterPrompts = agent.starter_prompts;
    if (typeof starterPrompts === 'string') {
        try { starterPrompts = JSON.parse(starterPrompts); } catch { starterPrompts = []; }
    }
    if (!Array.isArray(starterPrompts)) starterPrompts = [];
    return {
        id: agent.id,
        name: agent.name || 'Bee Flow Support',
        avatar: agent.avatar || '🛟',
        model: agent.model || 'tier:thinking',
        description: agent.description || '',
        systemPrompt: agent.system_prompt || '',
        starterPrompts,
        categoryId: agent.category_id || null,
        config: agent.config || {},
    };
}

const EMPTY_TIERS: ModelTierMap = {};

export default function SupportAIConfig() {
    const { t } = useTranslation();
    const [agent, setAgent] = useState<SupportAgentRow | null>(null);
    const [data, setData] = useState<SupportAgentData | null>(null);
    const [knowledgeBaseIds, setKnowledgeBaseIds] = useState<string[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [dirty, setDirty] = useState(false);
    const [previewInput, setPreviewInput] = useState('How do I cancel my subscription?');
    const [previewing, setPreviewing] = useState(false);
    const [previewReply, setPreviewReply] = useState<PreviewReply | null>(null);
    const [previewError, setPreviewError] = useState<string | null>(null);
    const [tab, setTab] = useState('agent');
    const mountedRef = useRef(true);

    // Set `true` on every (re-)mount and only `false` during cleanup. React 18
    // StrictMode runs effects twice in dev: mount → unmount (cleanup runs, ref
    // flips to false) → mount again — and without resetting here, the second
    // mount would keep mountedRef as `false`, silently swallowing every
    // setLoading/setSaving call after the first fetch.
    useEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; };
    }, []);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            let res: Response;
            try {
                res = await request(`${API_BASE}/api/support/agent`);
            } catch (err) {
                if (!(err instanceof RefusedError)) throw err;
                const e = errorBody(err) ?? {};
                setSaveError(e.error || 'Failed to load support agent');
                return;
            }
            const { agent: fetched } = await res.json();
            setAgent(fetched);
            setData(deriveAgentData(fetched));
            setKnowledgeBaseIds(fetched?.config?.knowledge_base_ids || []);
            setDirty(false);
        } catch (e) {
            setSaveError((e as Error).message);
        } finally {
            if (mountedRef.current) setLoading(false);
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    // Same tier source the rest of the app uses (InputArea, BuilderSplit, …).
    // We mirror it locally so we can surface a "this tier has no modelId in
    // your AI Config" warning without the admin having to test-reply first.
    const tiersQuery = useConfigTiersForUser();
    const tiers = tiersQuery.data ?? EMPTY_TIERS;

    // AgentEditorUI gives us field-level changes; we merge into our local
    // `data` and mark dirty so the Save button activates.
    const handleChange = useCallback((field: string, value: unknown) => {
        setData(prev => prev ? { ...prev, [field]: value } : prev);
        setDirty(true);
    }, []);

    // KnowledgePanel inside AgentEditorUI sends knowledgeBaseIds via the
    // PATCH /agents/:id/knowledge endpoint by itself (it calls the server
    // directly). For our singleton we want PUT /api/support/agent to also
    // carry the ids so the backend mirrors them into configStore. We track
    // the current list separately and pass it as the controlled value down
    // the editor via the `agentId` it already gets — the panel does its own
    // GET /api/kb call, no extra wiring needed.
    //
    // To keep the support route the single source of truth, we read the
    // freshly-saved agent back after save and re-seed our local state.

    const handleSave = useCallback(async () => {
        if (!data || saving) return;
        setSaving(true);
        setSaveError(null);
        try {
            const body = {
                name: data.name,
                description: data.description,
                systemPrompt: data.systemPrompt,
                model: data.model,
                starterPrompts: data.starterPrompts || [],
                // knowledgeBaseIds is intentionally NOT sent here — the
                // KnowledgePanel inside AgentEditorUI persists it via the
                // generic /agents/:id/knowledge endpoint. We refetch after
                // save and reflect the result.
            };
            try {
                await mutate(`${API_BASE}/api/support/agent`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            } catch (err) {
                if (!(err instanceof RefusedError)) throw err;
                const e = errorBody(err) ?? {};
                throw new Error(e.error || `Save failed (${err.status})`);
            }
            await load();
            setDirty(false);
        } catch (e) {
            setSaveError((e as Error).message);
        } finally {
            if (mountedRef.current) setSaving(false);
        }
    }, [data, saving, load]);

    const runPreview = useCallback(async () => {
        const message = previewInput.trim();
        if (!message || previewing) return;
        setPreviewing(true);
        setPreviewError(null);
        setPreviewReply(null);
        try {
            let res: Response;
            try {
                res = await mutate(`${API_BASE}/api/support/preview`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message }),
            });
            } catch (err) {
                if (!(err instanceof RefusedError)) throw err;
                const json = errorBody(err) ?? {};
                throw new Error(json.error || `Preview failed (${err.status})`);
            }
            const json = await res.json().catch(() => ({}));
            setPreviewReply(json);
        } catch (e) {
            setPreviewError((e as Error).message);
        } finally {
            if (mountedRef.current) setPreviewing(false);
        }
    }, [previewInput, previewing]);

    const tabs = [
        { id: 'agent', label: t('support.ai_config_tab_agent', 'Agent') },
        { id: 'behaviour', label: t('support.ai_config_tab_behaviour', 'AI behaviour') },
        { id: 'sla', label: t('support.ai_config_tab_sla', 'SLA') },
        { id: 'canned', label: t('support.ai_config_tab_templates', 'Templates') },
        { id: 'tags', label: t('support.ai_config_tab_tags', 'Tags') },
        { id: 'insights', label: t('support.ai_config_tab_insights', 'Insights') },
    ];

    return (
        <StudioShell
            responsive
            sidebar={<SectionNav label={t('support.ai_config_sections', 'AI configuration')} items={tabs} activeId={tab} onSelect={setTab} />}
        >
            <div className="flex h-full flex-col">
                {tab === 'behaviour' && <div className="flex-1 overflow-auto"><SupportToolsTab /></div>}
                {tab === 'sla' && <div className="flex-1 overflow-auto"><SupportSlaPoliciesTab /></div>}
                {tab === 'canned' && <div className="flex-1 overflow-auto"><SupportCannedResponsesTab /></div>}
                {tab === 'tags' && <div className="flex-1 overflow-auto"><SupportTagsTab /></div>}
                {tab === 'insights' && <div className="flex-1 overflow-auto"><SupportInsightsTab /></div>}

                {tab === 'agent' && loading && (
                    <div className="p-6 text-sm text-[var(--text-tertiary)]">{t('support.support_aiconfig_loading_bee_flow_support_agent', 'Loading Bee Flow Support agent…')}</div>
                )}
                {tab === 'agent' && !loading && !data && (
                    <div className="p-6 text-sm text-[var(--text-tertiary)]">
                        {saveError || t('support.ai_config_not_seeded', 'Bee Flow Support agent is not seeded yet. Restart the server.')}
                    </div>
                )}
                {tab === 'agent' && !loading && data && (
                    <>
                        <AgentSaveBar saveError={saveError} dirty={dirty} saving={saving} onSave={handleSave} />
                        <div className="flex-1 overflow-auto">
                            <TierCheck model={data.model} tiers={tiers} />
                            {/* Reuse the same editor the Studio uses */}
                            <AgentEditorUI
                                data={data}
                                onChange={handleChange}
                                isSystem={true}
                                hasKnowledge={true}
                                hasSkills={false}
                                agentId={agent?.id}
                                API_BASE={API_BASE}
                                categories={[]}
                                modelTiers={tiers}
                            />
                            <PreviewPane input={previewInput} setInput={setPreviewInput} previewing={previewing} onRun={runPreview} error={previewError} reply={previewReply} />
                        </div>
                    </>
                )}
            </div>
        </StudioShell>
    );
}

/** The bar above the editor: what this is, the save state and Save. */
function AgentSaveBar({ saveError, dirty, saving, onSave }: { saveError: string | null; dirty: boolean; saving: boolean; onSave: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-default)] px-4 py-2">
            <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
                <Sparkles className="h-3.5 w-3.5 text-[var(--text-tertiary)]" aria-hidden="true" />
                <span>{t('support.support_aiconfig_singleton_agent_same_editor_as_agent', 'Singleton agent · same editor as Agent Studio')}</span>
            </div>
            <div className="flex items-center gap-2">
                {saveError && (
                    <span className="flex items-center gap-1 text-xs text-[var(--error-ink)]">
                        <AlertTriangle className="h-3 w-3" aria-hidden="true" /> {saveError}
                    </span>
                )}
                {dirty && !saveError && (
                    <span className="text-xs text-[var(--text-tertiary)]">{t('support.support_aiconfig_unsaved_changes', 'Unsaved changes')}</span>
                )}
                <button type="button" onClick={onSave} disabled={!dirty || saving} className={PRIMARY_BTN}>
                    <Save className="h-3.5 w-3.5" aria-hidden="true" /> {saving ? t('support.ai_config_saving', 'Saving…') : t('support.ai_config_save', 'Save')}
                </button>
            </div>
        </div>
    );
}

/**
 * Inline sanity check: if the chosen tier has no modelId in this environment,
 * every customer thread will escalate with a "model not found" error. We
 * surface that immediately instead of letting the admin discover it via a
 * failed reply.
 */
function TierCheck({ model, tiers }: { model?: string; tiers: ModelTierMap }) {
    const { t } = useTranslation();
    if (!model || !model.startsWith('tier:')) return null;
    const tierKey = model.slice(5);
    if (tierKey === 'auto') return null;
    const tier = tiers[tierKey];
    if (tier && tier.modelId) {
        return (
            <div className="max-w-4xl px-4 pt-3 text-xs text-[var(--text-tertiary)]">
                {t('support.support_aiconfig_current_tier', 'Current tier')} <strong className="text-[var(--text-secondary)]">{tierKey}</strong> {t('support.support_aiconfig_resolves_to_model', 'resolves to model')} <code>{tier.modelId}</code>.
            </div>
        );
    }
    return (
        <div className="max-w-4xl px-4 pt-3">
            <div className={ALERT_ERROR}>
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <div>
                    <div className="font-medium">{t('support.support_aiconfig_tier', 'Tier')} <code>{tierKey}</code> {t('support.support_aiconfig_has_no_model_configured', 'has no model configured.')}</div>
                    <div className="opacity-80">{t('support.support_aiconfig_every_customer_thread_will_escalate_to', 'Every customer thread will escalate to staff until you either pick a different tier above or set')} <code>{tierKey}</code> {t('support.support_aiconfig_in_admin_ai_config_model_tiers', 'in Admin → AI Config → Model tiers.')}</div>
                </div>
            </div>
        </div>
    );
}

interface PreviewPaneProps {
    input: string;
    setInput: (v: string) => void;
    previewing: boolean;
    onRun: () => void;
    error: string | null;
    reply: PreviewReply | null;
}

/**
 * Preview pane — mirrors how MessageItem assistant replies look in the real
 * chat, using MarkdownRenderer (same component MessageItem uses internally).
 */
function PreviewPane({ input, setInput, previewing, onRun, error, reply }: PreviewPaneProps) {
    const { t } = useTranslation();
    return (
        <div className="mb-6 max-w-4xl p-4 pt-2">
            <div className={CARD}>
                <div className={EYEBROW}>{t('support.support_aiconfig_preview', 'Preview')}</div>
                <p className="m-0 text-xs text-[var(--text-tertiary)]">
                    {t('support.support_aiconfig_test_the_support_ai_without_creating_a', 'Test the support AI without creating a real thread. No emails, no notifications, no DB writes.')}
                </p>
                <textarea
                    value={input}
                    onChange={e => setInput(e.target.value)}
                    rows={3}
                    placeholder={t('support.support_aiconfig_type_a_question_as_if_you_were_a', 'Type a question as if you were a customer…')}
                    className={`${FIELD_INPUT} resize-y`}
                />
                <div className="flex justify-end">
                    <button type="button" onClick={onRun} disabled={previewing || !input.trim()} className={PRIMARY_BTN}>
                        <Send className="h-3.5 w-3.5" aria-hidden="true" /> {previewing ? t('support.ai_config_asking', 'Asking…') : t('support.ai_config_test_reply', 'Test reply')}
                    </button>
                </div>
                {error && <div className={ALERT_ERROR}>{error}</div>}
                {reply && <PreviewReplyCard reply={reply} />}
            </div>
        </div>
    );
}

function PreviewReplyCard({ reply }: { reply: PreviewReply }) {
    const { t } = useTranslation();
    return (
        <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-3 text-sm text-[var(--text-primary)]">
            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-[var(--text-tertiary)]">
                <span className="font-medium text-[var(--text-secondary)]">{t('support.support_aiconfig_bee_flow_support_ai', 'Bee Flow Support (AI)')}</span>
                {reply.modelTier && (
                    <span className={CHIP}>{tierLabel(reply.modelTier.replace(/^tier:/, '')) || reply.modelTier}</span>
                )}
                {reply.escalated && (
                    <span className={CHIP_WARNING}>
                        {t('support.support_aiconfig_would_escalate', 'would escalate')}{reply.escalateReason ? `: ${reply.escalateReason}` : ''}
                    </span>
                )}
            </div>
            {/* Reuse the same Markdown renderer the chat surface uses */}
            <MarkdownRenderer content={reply.content || ''} />
            {Array.isArray(reply.citations) && reply.citations.length > 0 && (
                <div className="mt-2 border-t border-[var(--border-default)] pt-2 text-xs text-[var(--text-tertiary)]">
                    {t('support.ai_config_cited', 'Cited: {sources}', { sources: reply.citations.map(c => c.title).filter(Boolean).join(' · ') })}
                </div>
            )}
        </div>
    );
}
