// The builder's Config tab: basic information, inputs, outputs, npm
// dependencies and (for a saved component) the danger zone.

import { useTranslation } from '../../../../hooks/useTranslation';
import InputsSection from './InputsSection';
import type { ComponentDraft } from './useComponentDraft';

const cardStyle = { background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)' };
const countStyle = { background: 'var(--bg-tertiary)', color: 'var(--text-muted)' };

function ToggleSwitch({ on, onColor, onClick }: { on: boolean; onColor: string; onClick: () => void }) {
    return (
        <div
            onClick={onClick}
            className="relative w-11 h-6 rounded-full transition-colors cursor-pointer"
            style={{ background: on ? onColor : 'var(--bg-tertiary)' }}
        >
            <div
                className="absolute top-1 w-4 h-4 rounded-full bg-white transition-transform"
                style={{ left: on ? '24px' : '4px' }}
            />
        </div>
    );
}

function BasicInfoFields({ draft, isCreating }: { draft: ComponentDraft; isCreating: boolean }) {
    const { t } = useTranslation();
    const { formData, setFormData, setIsDirty } = draft;
    return (
        <>
            <div>
                <label className="text-xs font-medium text-muted block mb-1.5">{t('component_studio.builder.component_id', 'Component ID')}</label>
                <input
                    type="text"
                    value={formData.id}
                    onChange={(e) => setFormData(prev => { setIsDirty(true); return { ...prev, id: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') }; })}
                    disabled={!isCreating}
                    placeholder="my-component"
                    className="input w-full font-mono"
                    style={{ opacity: isCreating ? 1 : 0.6 }}
                />
                <p className="text-xs text-muted mt-1">{t('component_studio.builder.id_hint', 'Lowercase, numbers, hyphens only')}</p>
            </div>
            <div>
                <label className="text-xs font-medium text-muted block mb-1.5">{t('component_studio.builder.display_name', 'Display Name')}</label>
                <input
                    type="text"
                    value={formData.name}
                    onChange={(e) => { setFormData({ ...formData, name: e.target.value }); setIsDirty(true); }}
                    placeholder={t('component_studio.builder.display_name_placeholder', 'My Component')}
                    className="input w-full"
                />
            </div>
            <div>
                <label className="text-xs font-medium text-muted block mb-1.5">{t('component_studio.builder.category', 'Category')}</label>
                <input
                    type="text"
                    value={formData.category}
                    onChange={(e) => { setFormData({ ...formData, category: e.target.value }); setIsDirty(true); }}
                    placeholder="Custom"
                    className="input w-full"
                />
                <p className="text-xs text-muted mt-1">{t('component_studio.builder.category_hint', 'Use / for nesting (e.g., API/REST)')}</p>
            </div>
            <div className="col-span-2">
                <label className="text-xs font-medium text-muted block mb-1.5">{t('component_studio.builder.description', 'Description')}</label>
                <textarea
                    value={formData.description}
                    onChange={(e) => { setFormData({ ...formData, description: e.target.value.slice(0, 500) }); setIsDirty(true); }}
                    placeholder={t('component_studio.builder.description_placeholder', 'What does this component do? (max 500 chars)')}
                    className="input w-full resize-none"
                    rows={3}
                    maxLength={500}
                />
                <p className="text-xs text-muted mt-1 text-right">{formData.description?.length || 0}/500</p>
            </div>
        </>
    );
}

function BasicInfoSection({ draft, isCreating }: { draft: ComponentDraft; isCreating: boolean }) {
    const { t } = useTranslation();
    const { formData, setFormData, setIsDirty } = draft;
    return (
        <div className="rounded-xl p-5" style={cardStyle}>
            <div className="flex items-center gap-2 mb-4">
                <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: 'rgba(99, 102, 241, 0.15)' }}>
                    <svg className="w-4 h-4" style={{ color: '#6366f1' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                </div>
                <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{t('component_studio.builder.basic_information', 'Basic Information')}</h3>
            </div>
            <div className="grid grid-cols-2 gap-4">
                <BasicInfoFields draft={draft} isCreating={isCreating} />
                <div className="col-span-2">
                    <label className="flex items-center gap-3 cursor-pointer">
                        <ToggleSwitch on={formData.agentEnabled} onColor="var(--accent-primary)" onClick={() => setFormData({ ...formData, agentEnabled: !formData.agentEnabled })} />
                        <div>
                            <span className="text-sm font-medium text-primary">{t('component_studio.builder.agent_tool', 'Enable as Agent Tool')}</span>
                            <p className="text-xs text-muted">{t('component_studio.builder.agent_tool_hint', 'Allow AI agents to use this tool')}</p>
                        </div>
                    </label>
                </div>
                <div className="col-span-2">
                    <label className="flex items-center gap-3 cursor-pointer">
                        <ToggleSwitch on={formData.directChatEnabled} onColor="#8b5cf6" onClick={() => { setFormData({ ...formData, directChatEnabled: !formData.directChatEnabled }); setIsDirty(true); }} />
                        <div>
                            <span className="text-sm font-medium text-primary">{t('component_studio.builder.direct_chat', 'Enable for Direct Chat')}</span>
                            <p className="text-xs text-muted">{t('component_studio.builder.direct_chat_hint', 'Make this tool available in direct chat mode')}</p>
                        </div>
                    </label>
                </div>
            </div>
        </div>
    );
}

function TypeSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
    return (
        <select value={value} onChange={(e) => onChange(e.target.value)} className="select">
            <option value="string">string</option>
            <option value="number">number</option>
            <option value="boolean">boolean</option>
            <option value="object">object</option>
            <option value="array">array</option>
            <option value="any">any</option>
        </select>
    );
}

function OutputsSection({ draft }: { draft: ComponentDraft }) {
    const { t } = useTranslation();
    const { outputsList, setOutputsList } = draft;
    return (
        <div className="rounded-xl p-5" style={cardStyle}>
            <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: 'rgba(168, 85, 247, 0.15)' }}>
                        <svg className="w-4 h-4" style={{ color: '#a855f7' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                        </svg>
                    </div>
                    <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{t('component_studio.builder.outputs', 'Outputs')}</h3>
                    <span className="text-xs px-1.5 py-0.5 rounded" style={countStyle}>
                        {outputsList.length}
                    </span>
                </div>
                <button
                    onClick={() => setOutputsList([...outputsList, { key: '', type: 'any' }])}
                    className="btn-secondary text-xs"
                >
                    {t('component_studio.builder.add_output', '+ Add Output')}
                </button>
            </div>
            <div className="space-y-2">
                {outputsList.map((out, i) => (
                    <div key={i} className="flex gap-2 items-center">
                        <input
                            type="text"
                            value={out.key}
                            onChange={(e) => { const l = [...outputsList]; l[i].key = e.target.value; setOutputsList(l); }}
                            placeholder="outputName"
                            className="input flex-1 font-mono"
                        />
                        <TypeSelect value={out.type} onChange={(v) => { const l = [...outputsList]; l[i].type = v; setOutputsList(l); }} />
                        <button
                            onClick={() => setOutputsList(outputsList.filter((_, j) => j !== i))}
                            className="btn-icon text-error"
                            style={{ border: 'none', background: 'transparent' }}
                        >
                            ×
                        </button>
                    </div>
                ))}
            </div>
        </div>
    );
}

function DependencyRows({ draft }: { draft: ComponentDraft }) {
    const { dependenciesList, setDependenciesList } = draft;
    return (
        <div className="space-y-2">
            {dependenciesList.map((dep, i) => (
                <div key={i} className="flex gap-2 items-center">
                    <input
                        type="text"
                        value={dep.name}
                        onChange={(e) => { const l = [...dependenciesList]; l[i].name = e.target.value; setDependenciesList(l); }}
                        placeholder="package-name"
                        className="input flex-1 font-mono"
                    />
                    <input
                        type="text"
                        value={dep.version}
                        onChange={(e) => { const l = [...dependenciesList]; l[i].version = e.target.value; setDependenciesList(l); }}
                        placeholder="^1.0.0"
                        className="input w-32 font-mono"
                    />
                    <button
                        onClick={() => setDependenciesList(dependenciesList.filter((_, j) => j !== i))}
                        className="btn-icon text-error"
                        style={{ border: 'none', background: 'transparent' }}
                    >
                        ×
                    </button>
                </div>
            ))}
        </div>
    );
}

function DependenciesSection({ draft }: { draft: ComponentDraft }) {
    const { t } = useTranslation();
    const { dependenciesList, setDependenciesList } = draft;
    return (
        <div className="rounded-xl p-5" style={cardStyle}>
            <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: 'rgba(249, 115, 22, 0.15)' }}>
                        <svg className="w-4 h-4" style={{ color: '#f97316' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                        </svg>
                    </div>
                    <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{t('component_studio.builder.npm_dependencies', 'NPM Dependencies')}</h3>
                    {dependenciesList.length > 0 && (
                        <span className="text-xs px-1.5 py-0.5 rounded" style={countStyle}>
                            {dependenciesList.length}
                        </span>
                    )}
                </div>
                <button
                    onClick={() => setDependenciesList([...dependenciesList, { name: '', version: 'latest' }])}
                    className="btn-secondary text-xs"
                >
                    {t('component_studio.builder.add_package', '+ Add Package')}
                </button>
            </div>
            {dependenciesList.length === 0 ? (
                <p className="text-sm text-muted">{t('component_studio.builder.no_dependencies', 'No dependencies. Built-in Node.js modules are always available.')}</p>
            ) : (
                <DependencyRows draft={draft} />
            )}
        </div>
    );
}

function DangerZone({ onDelete }: { onDelete: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="rounded-xl p-5 mt-2" style={{ border: '1px solid rgba(239, 68, 68, 0.2)' }}>
            <div className="flex items-center justify-between">
                <div>
                    <h3 className="text-sm font-semibold" style={{ color: '#ef4444' }}>{t('component_studio.builder.danger_zone', 'Danger Zone')}</h3>
                    <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{t('component_studio.builder.danger_hint', 'Permanently delete this component and all its files')}</p>
                </div>
                <button
                    onClick={onDelete}
                    className="px-4 py-2 text-sm font-medium rounded-lg transition-all flex items-center gap-2"
                    style={{
                        border: '1px solid rgba(239, 68, 68, 0.4)',
                        background: 'rgba(239, 68, 68, 0.1)',
                        color: '#ef4444',
                    }}
                >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                    {t('component_studio.builder.delete_component', 'Delete Component')}
                </button>
            </div>
        </div>
    );
}

interface ConfigTabProps {
    draft: ComponentDraft;
    isCreating: boolean;
    selectedComponent: string | null;
    onDelete: () => void;
}

export default function ConfigTab({ draft, isCreating, selectedComponent, onDelete }: ConfigTabProps) {
    return (
        <div className="p-6 space-y-6 max-w-4xl">
            {/* Basic Info */}
            <BasicInfoSection draft={draft} isCreating={isCreating} />
            {/* Inputs */}
            <InputsSection draft={draft} />
            {/* Outputs */}
            <OutputsSection draft={draft} />
            {/* Dependencies */}
            <DependenciesSection draft={draft} />
            {/* Delete Component */}
            {selectedComponent && !isCreating && <DangerZone onDelete={onDelete} />}
        </div>
    );
}
