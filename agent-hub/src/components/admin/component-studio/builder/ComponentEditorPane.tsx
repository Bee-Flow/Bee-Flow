// The builder's right-hand side: the tab bar with the id badge, the unsaved
// marker and Save, the open tab (Config, index.js or Test), or the empty
// state when nothing is open.

import { useTranslation } from '../../../../hooks/useTranslation';
import ConfigTab from './ConfigTab';
import Editor from './LazyEditor';
import TestTab from './TestTab';
import type { ComponentEditor } from './useComponentEditor';

const TAB_ICONS = {
    config: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z',
    code: 'M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4',
    test: 'M13 10V3L4 14h7v7l9-11h-7z',
};

function SaveButton({ isSaving, onSave }: { isSaving: boolean; onSave: () => void }) {
    const { t } = useTranslation();
    return (
        <button
            onClick={onSave}
            disabled={isSaving}
            className="btn-primary text-xs px-4 py-1.5 flex items-center gap-1.5"
            title={t('component_studio.builder.save_title', 'Save component changes')}
        >
            {isSaving ? (
                <>
                    <div className="spinner" style={{ width: '12px', height: '12px' }}></div>
                    {t('component_studio.builder.saving', 'Saving...')}
                </>
            ) : (
                <>
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    {t('component_studio.builder.save', 'Save')}
                </>
            )}
        </button>
    );
}

function TabBar({ editor }: { editor: ComponentEditor }) {
    const { t } = useTranslation();
    const { activeTab, setActiveTab, selectedComponent, draft, isSaving, handleSave } = editor;
    const tabs = [
        { id: 'config', label: t('component_studio.builder.tab_config', 'Config'), icon: TAB_ICONS.config },
        { id: 'code', label: 'index.js', icon: TAB_ICONS.code },
        { id: 'test', label: t('component_studio.builder.tab_test', 'Test'), icon: TAB_ICONS.test },
    ];
    return (
        <div className="flex items-center gap-1 px-4 py-2 border-b" style={{ borderColor: 'var(--border-default)', background: 'var(--bg-secondary)' }}>
            {tabs.map(tab => (
                <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-all"
                    style={{
                        background: activeTab === tab.id ? 'var(--accent-primary)' : 'transparent',
                        color: activeTab === tab.id ? 'white' : 'var(--text-muted)',
                        boxShadow: activeTab === tab.id ? '0 2px 8px rgba(99, 102, 241, 0.3)' : 'none',
                    }}
                >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={tab.icon} />
                        {tab.id === 'config' && <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />}
                    </svg>
                    {tab.label}
                </button>
            ))}

            {/* Component ID indicator and Save button */}
            <div className="ml-auto flex items-center gap-3 text-xs text-muted px-2">
                <span className="badge badge-primary font-mono">{selectedComponent || draft.formData.id || 'new-component'}</span>
                {draft.isDirty && (
                    <span className="flex items-center gap-1.5 text-xs" style={{ color: '#f59e0b' }}>
                        <span className="w-1.5 h-1.5 rounded-full" style={{ background: '#f59e0b' }} />
                        {t('component_studio.builder.unsaved', 'Unsaved')}
                    </span>
                )}
                <SaveButton isSaving={isSaving} onSave={handleSave} />
            </div>
        </div>
    );
}

function CodeTab({ editor }: { editor: ComponentEditor }) {
    const { t } = useTranslation();
    const { formData, setFormData, setIsDirty } = editor.draft;
    return (
        <div className="h-full flex flex-col p-4">
            <div className="flex items-center justify-between mb-3 px-1">
                <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full" style={{ background: '#f59e0b' }} />
                    <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>index.js</span>
                </div>
                <span className="text-xs px-2 py-1 rounded" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}>
                    {t('component_studio.builder.lines', '{n} lines', { n: formData.code.split('\n').length })}
                </span>
            </div>
            <div className="flex-1 rounded-xl overflow-hidden border" style={{ borderColor: 'var(--border-default)' }}>
                <Editor
                    height="100%"
                    defaultLanguage="javascript"
                    theme="vs-dark"
                    value={formData.code}
                    onChange={(value) => { setFormData({ ...formData, code: value || '' }); setIsDirty(true); }}
                    options={{
                        fontSize: 13,
                        fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
                        minimap: { enabled: false },
                        scrollBeyondLastLine: false,
                        padding: { top: 16, bottom: 16 },
                        lineNumbers: 'on',
                        renderLineHighlight: 'line',
                        cursorBlinking: 'smooth',
                        automaticLayout: true,
                        tabSize: 2,
                        wordWrap: 'on'
                    }}
                />
            </div>
        </div>
    );
}

function EmptyState({ onNew, onOpenAI }: { onNew: () => void; onOpenAI: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="flex-1 flex items-center justify-center">
            <div style={{ textAlign: 'center', maxWidth: '400px' }}>
                <div style={{
                    width: '80px', height: '80px', borderRadius: '20px', margin: '0 auto 24px',
                    background: 'linear-gradient(135deg, rgba(99, 102, 241, 0.2), rgba(168, 85, 247, 0.2))',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    boxShadow: '0 8px 32px rgba(99, 102, 241, 0.15)',
                }}>
                    <svg style={{ width: '36px', height: '36px', color: '#818cf8' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M11 4a2 2 0 114 0v1a1 1 0 001 1h3a1 1 0 011 1v3a1 1 0 01-1 1h-1a2 2 0 100 4h1a1 1 0 011 1v3a1 1 0 01-1 1h-3a1 1 0 01-1-1v-1a2 2 0 10-4 0v1a1 1 0 01-1 1H7a1 1 0 01-1-1v-3a1 1 0 00-1-1H4a2 2 0 110-4h1a1 1 0 001-1V7a1 1 0 011-1h3a1 1 0 001-1V4z" />
                    </svg>
                </div>
                <h3 className="text-lg font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>{t('component_studio.builder.empty_title', 'Select or Create a Component')}</h3>
                <p className="text-sm mb-6" style={{ color: 'var(--text-muted)', lineHeight: '1.6' }}>{t('component_studio.builder.empty_body', 'Components are reusable tools that your AI agents can call. Pick one from the sidebar or create a new one.')}</p>
                <div className="flex gap-3 justify-center">
                    <button onClick={onNew} className="btn-primary flex items-center gap-2 px-5 py-2.5">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                        </svg>
                        {t('component_studio.builder.new_component', 'New Component')}
                    </button>
                    <button onClick={onOpenAI} className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium transition-all" style={{ border: '1px solid var(--accent-primary)', color: 'var(--accent-primary)', background: 'rgba(99, 102, 241, 0.08)' }}>
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                        </svg>
                        {t('component_studio.builder.ai_designer', 'AI Designer')}
                    </button>
                </div>
            </div>
        </div>
    );
}

export default function ComponentEditorPane({ editor, onOpenAI }: { editor: ComponentEditor; onOpenAI: () => void }) {
    const { selectedComponent, isCreating, activeTab, draft } = editor;
    return (
        <div className="flex-1 flex flex-col overflow-hidden">
            {(selectedComponent || isCreating) ? (
                <>
                    {/* Tabs */}
                    <TabBar editor={editor} />

                    {/* Tab Content */}
                    <div className="flex-1 overflow-auto">
                        {activeTab === 'config' && (
                            <ConfigTab draft={draft} isCreating={isCreating} selectedComponent={selectedComponent} onDelete={editor.handleDelete} />
                        )}
                        {activeTab === 'code' && <CodeTab editor={editor} />}
                        {activeTab === 'test' && (
                            <TestTab draft={draft} isCreating={isCreating} onRun={editor.handleTest} onSaveSample={editor.handleSaveSampleOutput} />
                        )}
                    </div>
                </>
            ) : (
                <EmptyState onNew={editor.handleNewComponent} onOpenAI={onOpenAI} />
            )}
        </div>
    );
}
