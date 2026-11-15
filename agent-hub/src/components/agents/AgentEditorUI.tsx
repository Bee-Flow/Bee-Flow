import { useState } from 'react';
import KnowledgePanel from '../knowledge/KnowledgePanel';
import VersionHistory from './VersionHistory';
import ModelTierSelector from '../licensing/ModelTierSelector';
import { isImageAvatar, resolveAvatarSrc, DEFAULT_AGENT_EMOJI } from '../../utils/agentAvatar';
import { useUrlQueryParam } from '../../hooks/useUrlTab';
import AgentSkillsTab from './AgentSkillsTab';
import { useTranslation } from '../../hooks/useTranslation';
import type { ModelTierMap } from '../../api/queries/modelTiers';
import type { AgentEditorData, AgentEditorUIProps } from './AgentEditorUI.types';
import { useConfigTiersForUser } from '../../api/queries/configModels';
import Toggle from '../shared/Toggle';
import { PRIMARY_BTN } from '../shared/adminUi';
import { defaultWidgetOptions, widgetSnippet } from './AgentDesigner/sections/embedSnippet';
export type { ToolParamConfig, AgentFormData,  EditorOrganization, EditorGroup, EditorCategory } from './AgentEditorUI.types';

const EMPTY_TIERS: ModelTierMap = {};

const AgentEditorUI = ({
    data,
    onChange,
    availableModels = [],
    isSystem = false,
    hasKnowledge = true,
    hasSkills = true,
    user = null,
    agentId,
    API_BASE,

    // Organization & group sharing
    organizations = [],
    groups = [],
    // Agent categories
    categories = [],
    onCreateCategory,
    // When set (e.g. 'editTab'), the inner tab is mirrored on a URL query
    // parameter so the editor is deep-linkable. Undefined → local state only.
    urlSyncKey = null,
    // Tier definitions for the canonical ModelTierSelector. When omitted we
    // fetch from `/ai/config/tiers-for-user?taskType=direct_chat` ourselves —
    // exact same endpoint InputArea / BuilderSplit / AgentDesigner consume —
    // so admins see only tiers that are actually configured + entitled.
    modelTiers: modelTiersProp = null,
}: AgentEditorUIProps) => {
    const { t } = useTranslation();
    const VALID_TABS: (string | null)[] = ['general', ...(hasKnowledge ? ['knowledge'] : []), ...(hasSkills ? ['skills'] : [])];
    const [urlTab, setUrlTab] = useUrlQueryParam(urlSyncKey || '__noop_editor_tab__');
    const [localTab, setLocalTab] = useState('general');
    // Without tiers from the caller, read them; a refusal or a failure keeps them empty
    // (the selector still shows the standard tiers).
    const tiersQuery = useConfigTiersForUser(!modelTiersProp);
    const modelTiers: ModelTierMap = modelTiersProp || (tiersQuery.data ?? EMPTY_TIERS);
    const activeTab = urlSyncKey
        ? (VALID_TABS.includes(urlTab) ? urlTab : 'general')
        : localTab;
    const setActiveTab = (v: string) => {
        if (urlSyncKey) setUrlTab(v);
        else setLocalTab(v);
    };
    const [showEmojiPicker, setShowEmojiPicker] = useState(false);
    const [showNewCategory, setShowNewCategory] = useState(false);
    const [newCategoryName, setNewCategoryName] = useState('');

    // Local handler to simplify standard inputs
    const handleChange = (field: string, value: unknown) => {
        onChange(field, value);
    };

    return (
        <div className="flex flex-col h-full bg-[var(--bg-primary)]">
            {/* Tabs */}
            <AgentEditorUISection hasKnowledge={hasKnowledge} hasSkills={hasSkills} setActiveTab={setActiveTab} activeTab={activeTab} />

            {/* Content Area */}
            <div className="flex-1 overflow-auto p-4">
                {/* GENERAL TAB */}
                {activeTab === 'general' && (
                    <div className="max-w-2xl space-y-4">
                        {/* Identity Row */}
                        <div className="grid grid-cols-12 gap-4">
                            {/* Avatar */}
                            <div className="col-span-2 relative">
                                <label className="text-xs mb-1 block text-[var(--text-muted)]">{t('agent.agent_editor_ui_avatar', 'Avatar')}</label>
                                <button
                                    type="button"
                                    onClick={() => setShowEmojiPicker(!showEmojiPicker)}
                                    className="w-full aspect-square text-2xl rounded-xl border border-[var(--border-default)] bg-[var(--bg-tertiary)] flex items-center justify-center hover:border-[var(--accent-primary)] transition-all overflow-hidden"
                                >
                                    {isImageAvatar(data.avatar) ? (
                                        <img src={resolveAvatarSrc(data.avatar)} alt="" className="w-full h-full object-cover" />
                                    ) : (data.avatar || DEFAULT_AGENT_EMOJI)}
                                </button>
                                {showEmojiPicker && (
                                    <div className="absolute top-full left-0 mt-2 p-3 rounded-xl border border-[var(--border-default)] bg-[var(--bg-secondary)] shadow-xl z-50 w-64">
                                        <div className="grid grid-cols-6 gap-1 mb-2">
                                            {['🤖', '🧠', '💡', '🔧', '📊', '📝', '🔍', '🎯', '⚡', '🚀', '💻', '📱', '🌐', '🔐', '📈', '🎨', '🛠️', '📧', '💬', '🗂️', '📅', '⏰', '🔔', '✅'].map(emoji => (
                                                <button
                                                    key={emoji}
                                                    onClick={() => {
                                                        handleChange('avatar', emoji);
                                                        setShowEmojiPicker(false);
                                                    }}
                                                    className="aspect-square flex items-center justify-center rounded hover:bg-[var(--item-hover-bg)] text-lg"
                                                >
                                                    {emoji}
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>

                            {/* Name & Model */}
                            <div className="col-span-10 space-y-4">
                                <div>
                                    <label className="text-xs mb-1 block text-[var(--text-muted)]">{t('agent.agent_editor_ui_agent_name', 'Agent Name')}</label>
                                    <input
                                        type="text"
                                        value={data.name || ''}
                                        onChange={e => handleChange('name', e.target.value)}
                                        className="w-full px-4 py-2 rounded-xl border border-[var(--border-default)] bg-[var(--bg-tertiary)] text-[var(--text-primary)] focus:border-[var(--accent-primary)] outline-none"
                                        placeholder={t('agent.agent_editor_ui_my_agent', 'My Agent')}
                                    />
                                </div>
                                <div>
                                    <div>
                                        <label className="text-xs mb-1 block text-[var(--text-muted)]">{t('agent.agent_editor_ui_model', 'Model')}</label>
                                        {/* Canonical tier picker — same component direct chat (InputArea),
                                            BuilderSplit, AgentDesigner and AITasksDesigner use. Tier list
                                            is fetched from /ai/config/tiers-for-user?taskType=direct_chat
                                            so we surface exactly the tiers the caller is actually allowed
                                            and that have a configured modelId. */}
                                        <ModelTierSelector
                                            tiers={modelTiers || {}}
                                            value={data.model ? data.model.replace('tier:', '') : 'auto'}
                                            onChange={(tier) => handleChange('model', `tier:${tier}`)}
                                            dropDirection="down"
                                        />
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div>
                            <div>
                                <label className="text-xs mb-1 block text-[var(--text-muted)]">{t('agent.agent_editor_ui_category', 'Category')}</label>
                                <div className="flex items-center gap-2">
                                    <select
                                        value={data.categoryId || ''}
                                        onChange={e => handleChange('categoryId', e.target.value || null)}
                                        className="flex-1 px-4 py-2 rounded-xl border border-[var(--border-default)] bg-[var(--bg-tertiary)] text-[var(--text-primary)] focus:border-[var(--accent-primary)] outline-none text-sm"
                                    >
                                        <option value="">{t('agent.agent_editor_ui_none_default_agent', 'None (default "Agent")')}</option>
                                        {categories.map(cat => (
                                            <option key={cat.id} value={cat.id}>{cat.icon} {cat.name}</option>
                                        ))}
                                    </select>
                                    {onCreateCategory && (
                                        <button
                                            type="button"
                                            onClick={() => setShowNewCategory(!showNewCategory)}
                                            className="px-3 py-2 rounded-xl border border-[var(--border-default)] bg-[var(--bg-tertiary)] text-[var(--text-primary)] hover:border-[var(--accent-primary)] transition-all text-sm"
                                            title={t('agent.agent_editor_ui_create_new_category', 'Create new category')}
                                        >
                                            +
                                        </button>
                                    )}
                                </div>
                                {showNewCategory && onCreateCategory && (
                                    <div className="mt-2 flex items-center gap-2">
                                        <input
                                            type="text"
                                            value={newCategoryName}
                                            onChange={e => setNewCategoryName(e.target.value)}
                                            className="flex-1 px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-tertiary)] text-[var(--text-primary)] text-sm"
                                            placeholder={t('agent.agent_editor_ui_category_name', 'Category name...')}
                                            onKeyDown={e => {
                                                if (e.key === 'Enter' && newCategoryName.trim()) {
                                                    onCreateCategory(newCategoryName.trim());
                                                    setNewCategoryName('');
                                                    setShowNewCategory(false);
                                                }
                                            }}
                                            autoFocus
                                        />
                                        <button
                                            type="button"
                                            onClick={() => {
                                                if (newCategoryName.trim()) {
                                                    onCreateCategory(newCategoryName.trim());
                                                    setNewCategoryName('');
                                                    setShowNewCategory(false);
                                                }
                                            }}
                                            disabled={!newCategoryName.trim()}
                                            className={PRIMARY_BTN}
                                        >
                                            {t('agent.agent_editor_ui_create', 'Create')}
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => { setShowNewCategory(false); setNewCategoryName(''); }}
                                            className="px-2 py-2 rounded-lg text-xs text-[var(--text-muted)] hover:bg-[var(--item-hover-bg)]"
                                        >
                                            ✕
                                        </button>
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Description */}
                        <div>
                            <label className="text-xs mb-1 block text-[var(--text-muted)]">{t('agent.agent_editor_ui_description', 'Description')}</label>
                            <input
                                type="text"
                                value={data.description || ''}
                                onChange={e => handleChange('description', e.target.value)}
                                className="w-full px-4 py-2 rounded-xl border border-[var(--border-default)] bg-[var(--bg-tertiary)] text-[var(--text-primary)] focus:border-[var(--accent-primary)] outline-none"
                                placeholder={t('agent.agent_editor_ui_what_does_this_agent_do', 'What does this agent do?')}
                            />
                        </div>

                        {/* System Prompt */}
                        <div>
                            <label className="text-xs mb-1 block text-[var(--text-muted)]">{t('agent.agent_editor_ui_system_prompt', 'System Prompt')}</label>
                            <textarea
                                value={data.systemPrompt || data.system_prompt || ''}
                                onChange={e => handleChange('systemPrompt', e.target.value)}
                                className="w-full px-4 py-3 rounded-xl border border-[var(--border-default)] bg-[var(--bg-tertiary)] text-[var(--text-primary)] font-mono text-sm focus:border-[var(--accent-primary)] outline-none resize-y"
                                rows={8}
                                placeholder={t('agent.agent_editor_ui_you_are_a_helpful_ai_assistant', 'You are a helpful AI assistant...')}
                            />
                        </div>



                        <div>
                            <div>
                                <label className="text-xs mb-2 block text-[var(--text-muted)]">{t('agent.agent_editor_ui_starter_prompts', 'Starter Prompts')}</label>
                                <div className="space-y-2">
                                    {(data.starterPrompts || []).map((prompt, index) => (
                                        <div key={index} className="flex items-center gap-2">
                                            <input
                                                type="text"
                                                value={prompt}
                                                onChange={(e) => {
                                                    const newPrompts = [...(data.starterPrompts || [])];
                                                    newPrompts[index] = e.target.value;
                                                    handleChange('starterPrompts', newPrompts);
                                                }}
                                                className="flex-1 px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-tertiary)] text-[var(--text-primary)] text-sm"
                                                placeholder={t('agent.agent_editor_ui_enter_a_starter_prompt', 'Enter a starter prompt...')}
                                            />
                                            <button
                                                onClick={() => {
                                                    const newPrompts = (data.starterPrompts || []).filter((_, i) => i !== index);
                                                    handleChange('starterPrompts', newPrompts);
                                                }}
                                                className="p-2 rounded-lg hover:bg-[var(--item-hover-bg)] text-[var(--error-ink)]"
                                            >
                                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                                            </button>
                                        </div>
                                    ))}
                                    <button
                                        onClick={() => handleChange('starterPrompts', [...(data.starterPrompts || []), ''])}
                                        className="text-xs text-[var(--accent-primary)] hover:underline flex items-center gap-1"
                                    >
                                        {t('agent.agent_editor_ui_add_prompt', '+ Add Prompt')}
                                    </button>
                                </div>
                            </div>
                        </div>

                        <div className="space-y-4">
                            <div className="space-y-4">
                                <div className="grid grid-cols-3 gap-4">
                                    <div className="flex items-center justify-between p-3 rounded-xl border border-[var(--border-default)] bg-[var(--bg-tertiary)]">
                                        <div>
                                            <div className="text-sm font-medium text-[var(--text-primary)]">{t('agent.agent_editor_ui_allow_copy', 'Allow Copy')}</div>
                                            <div className="text-xs text-[var(--text-muted)]">{t('agent.agent_editor_ui_copy_button', 'Copy button')}</div>
                                        </div>
                                        <Toggle checked={!!data.copyEnabled} onChange={(next) => handleChange('copyEnabled', next)} ariaLabel={t('agent.agent_editor_ui_allow_copy', 'Allow Copy')} />
                                    </div>
                                    <div className="flex items-center justify-between p-3 rounded-xl border border-[var(--border-default)] bg-[var(--bg-tertiary)]">
                                        <div>
                                            <div className="text-sm font-medium text-[var(--text-primary)]">{t('agent.agent_editor_ui_web_embed', 'Web Embed')}</div>
                                            <div className="text-xs text-[var(--text-muted)]">{t('agent.agent_editor_ui_public_chat_page', 'Public chat page')}</div>
                                        </div>
                                        <Toggle checked={!!data.embedEnabled} onChange={(next) => handleChange('embedEnabled', next)} ariaLabel={t('agent.agent_editor_ui_web_embed', 'Web Embed')} />
                                    </div>
                                    <div className="flex items-center justify-between p-3 rounded-xl border border-[var(--border-default)] bg-[var(--bg-tertiary)]">
                                        <div>
                                            <div className="text-sm font-medium text-[var(--text-primary)]">{t('agent.agent_editor_ui_no_external', 'No External')}</div>
                                            <div className="text-xs text-[var(--text-muted)]">{t('agent.agent_editor_ui_no_integrations_search', 'No integrations/search')}</div>
                                        </div>
                                        <Toggle checked={!!data.disableExternalTools} onChange={(next) => handleChange('disableExternalTools', next)} ariaLabel={t('agent.agent_editor_ui_no_external', 'No External')} />
                                    </div>
                                </div>

                                {/* Embed URL Info Card */}
                                {data.embedEnabled && agentId && (
                                    <div className="p-4 rounded-xl border border-[var(--border-default)] bg-[var(--bg-secondary)] space-y-3">
                                        <div className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]">
                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" /></svg>
                                            {t('agent.agent_editor_ui_embed_settings', 'Embed Settings')}
                                        </div>
                                        <div>
                                            <label className="text-xs text-[var(--text-muted)] mb-1 block">{t('agent.agent_editor_ui_public_url', 'Public URL')}</label>
                                            <div className="flex gap-2">
                                                <input
                                                    readOnly
                                                    value={`${window.location.origin}/chat/${agentId}`}
                                                    className="flex-1 text-xs font-mono px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] text-[var(--text-secondary)]"
                                                />
                                                <button
                                                    onClick={() => {
                                                        navigator.clipboard.writeText(`${window.location.origin}/chat/${agentId}`);
                                                    }}
                                                    className={PRIMARY_BTN}
                                                >
                                                    {t('agent.agent_editor_ui_copy', 'Copy')}
                                                </button>
                                            </div>
                                        </div>
                                        <div>
                                            <label className="text-xs text-[var(--text-muted)] mb-1 block">{t('agent.agent_editor_ui_iframe_embed', 'Iframe Embed')}</label>
                                            <div className="flex gap-2">
                                                <input
                                                    readOnly
                                                    value={`<iframe src="${window.location.origin}/chat/${agentId}" width="400" height="600" style="border:none;border-radius:12px;"></iframe>`}
                                                    className="flex-1 text-xs font-mono px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] text-[var(--text-secondary)]"
                                                />
                                                <button
                                                    onClick={() => {
                                                        navigator.clipboard.writeText(`<iframe src="${window.location.origin}/chat/${agentId}" width="400" height="600" style="border:none;border-radius:12px;"></iframe>`);
                                                    }}
                                                    className={PRIMARY_BTN}
                                                >
                                                    {t('agent.agent_editor_ui_copy', 'Copy')}
                                                </button>
                                            </div>
                                        </div>
                                        <div>
                                            <label className="text-xs text-[var(--text-muted)] mb-1 block">{t('agent.agent_editor_ui_chat_bubble_widget', 'Chat Bubble Widget')}</label>
                                            <p className="text-[10px] text-[var(--text-muted)] mb-2">{t('agent.agent_editor_ui_a_floating_chat_button_that_opens_the', 'A floating chat button that opens the agent in a popup. Paste this before')} {'</body>'}.</p>
                                            <div className="flex gap-2">
                                                <textarea
                                                    readOnly
                                                    rows={4}
                                                    value={widgetSnippet(defaultWidgetOptions(agentId, window.location.origin), true)}
                                                    className="flex-1 text-xs font-mono px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] text-[var(--text-secondary)] resize-none"
                                                />
                                                <button
                                                    onClick={() => {
                                                        void navigator.clipboard.writeText(widgetSnippet(defaultWidgetOptions(agentId, window.location.origin)));
                                                    }}
                                                    className={`${PRIMARY_BTN} self-start`}
                                                >
                                                    {t('agent.agent_editor_ui_copy', 'Copy')}
                                                </button>
                                            </div>
                                        </div>
                                        <p className="text-[10px] text-[var(--text-muted)]">{t('agent.agent_editor_ui_agent_must_be_published_for_the_embed', 'Agent must be Published for the embed link to work.')}</p>
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Organization & Sharing */}
                        {organizations.length > 0 && (
                            <div className="p-4 rounded-xl border border-[var(--border-default)] bg-[var(--bg-tertiary)] space-y-3">
                                <div className="text-sm font-medium text-[var(--text-primary)] flex items-center gap-2">
                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" /></svg>
                                    {t('agent.agent_editor_ui_organization_sharing', 'Organization & Sharing')}
                                </div>
                                <div>
                                    <label className="text-xs mb-1 block text-[var(--text-muted)]">{t('agent.agent_editor_ui_organization', 'Organization')}</label>
                                    <select
                                        value={data.organizationId || ''}
                                        onChange={e => {
                                            handleChange('organizationId', e.target.value);
                                            // Clear shared groups when org changes
                                            if (e.target.value !== data.organizationId) {
                                                handleChange('sharedGroups', []);
                                            }
                                        }}
                                        className="w-full px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-[var(--text-primary)] text-sm outline-none"
                                    >
                                        <option value="">{t('agent.agent_editor_ui_none_global_visible_to_all', 'None (Global — visible to all)')}</option>
                                        {organizations.map(org => (
                                            <option key={org.id} value={org.id}>{org.name}</option>
                                        ))}
                                    </select>
                                </div>
                                {data.organizationId && (() => {
                                    const orgGroups = groups.filter(g => g.organizationId === data.organizationId);
                                    if (orgGroups.length === 0) return null;
                                    return (
                                        <div>
                                            <label className="text-xs mb-2 block text-[var(--text-muted)]">{t('agent.agent_editor_ui_share_with_specific_groups_leave_empty', 'Share with specific groups (leave empty for all org members)')}</label>
                                            <div className="space-y-1 max-h-32 overflow-auto">
                                                {orgGroups.map(group => (
                                                    <label key={group.id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[var(--item-hover-bg)] cursor-pointer">
                                                        <input
                                                            type="checkbox"
                                                            checked={(data.sharedGroups || []).includes(group.id)}
                                                            onChange={e => {
                                                                const current = data.sharedGroups || [];
                                                                const updated = e.target.checked
                                                                    ? [...current, group.id]
                                                                    : current.filter(id => id !== group.id);
                                                                handleChange('sharedGroups', updated);
                                                            }}
                                                            className="rounded"
                                                        />
                                                        <span className="text-sm text-[var(--text-primary)]">{group.name}</span>
                                                        {group.description && <span className="text-xs text-[var(--text-muted)]">— {group.description}</span>}
                                                    </label>
                                                ))}
                                            </div>
                                        </div>
                                    );
                                })()}
                            </div>
                        )}

                        {/* Version History (existing agents only) */}
                        {agentId && (
                            <VersionHistory agentId={agentId} onRestore={() => window.location.reload()} />
                        )}
                    </div>
                )}

                {/* KNOWLEDGE TAB */}
                {activeTab === 'knowledge' && hasKnowledge && (
                    <KnowledgePanel agentId={agentId} API_BASE={API_BASE} strictKnowledge={data.strictKnowledge} onStrictKnowledgeChange={(val) => onChange('strictKnowledge', val)} includeSourceReferences={data.includeSourceReferences} onIncludeSourceReferencesChange={(val) => onChange('includeSourceReferences', val)} />
                )}

                {/* SKILLS TAB */}
                {activeTab === 'skills' && hasSkills && (
                    <AgentSkillsTab
                        user={user}
                        attachedSkillIds={Array.isArray(data?.config?.attachedSkillIds) ? data.config.attachedSkillIds : []}
                        onChangeAttached={(nextIds) => onChange('config', { ...(data.config || {}), attachedSkillIds: nextIds })}
                    />
                )}

            </div>
        </div>
    );
};

export default AgentEditorUI;

function AgentEditorUISection({ hasKnowledge, hasSkills, setActiveTab, activeTab }: { hasKnowledge: boolean; hasSkills: boolean; setActiveTab: (v: string) => void; activeTab: string | null; }) {
    const { t } = useTranslation();
    const tabs = [
        { id: 'general', label: t('agent_designer.editor_tab_general', 'General') },
        ...(hasKnowledge ? [{ id: 'knowledge', label: t('agent_designer.editor_tab_knowledge', 'Knowledge') }] : []),
        ...(hasSkills ? [{ id: 'skills', label: t('agent_designer.editor_tab_skills', 'Skills') }] : []),
    ];
    return <div className="flex border-b border-[var(--border-default)] bg-[var(--bg-secondary)]">
        {tabs.map(tab => (
            <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`px-4 py-2 text-sm font-medium transition-colors relative ${activeTab === tab.id
                    ? 'text-[var(--text-primary)]'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}
            >
                {tab.label}
                {activeTab === tab.id && (
                    <div className="absolute bottom-0 left-0 w-full h-0.5 bg-[var(--accent-primary)]" />
                )}
            </button>
        ))}
    </div>;
}
