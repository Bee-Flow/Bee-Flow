// The config tab's Inputs card: one card per input with its name, type,
// secret toggle, default value and description.

import { useTranslation } from '../../../../hooks/useTranslation';
import type { ComponentDraft } from './useComponentDraft';
import type { InputRow } from './componentForm';

const typeColors: Record<string, { bg: string; color: string }> = {
    string: { bg: 'rgba(59, 130, 246, 0.12)', color: '#60a5fa' },
    number: { bg: 'rgba(34, 197, 94, 0.12)', color: '#4ade80' },
    boolean: { bg: 'rgba(168, 85, 247, 0.12)', color: '#c084fc' },
    object: { bg: 'rgba(249, 115, 22, 0.12)', color: '#fb923c' },
    array: { bg: 'rgba(236, 72, 153, 0.12)', color: '#f472b6' },
    any: { bg: 'rgba(100, 116, 139, 0.12)', color: '#94a3b8' },
};

const smallLabelStyle = { color: 'var(--text-muted)', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.05em' } as const;

type DraftInputs = Pick<ComponentDraft, 'inputsList' | 'setInputsList' | 'setIsDirty'>;

function InputCardHeader({ inp, i, tc, draft }: { inp: InputRow; i: number; tc: { bg: string; color: string }; draft: DraftInputs }) {
    const { t } = useTranslation();
    const { inputsList, setInputsList, setIsDirty } = draft;
    return (
        <div className="flex items-center gap-2.5 px-3.5 pt-3 pb-1">
            <input
                type="text"
                value={inp.key}
                onChange={(e) => { const l = [...inputsList]; l[i].key = e.target.value; setInputsList(l); setIsDirty(true); }}
                placeholder="inputName"
                className="font-mono text-sm font-semibold bg-transparent border-none outline-none"
                style={{ color: 'var(--text-primary)', width: '150px' }}
            />
            <select
                value={inp.type}
                onChange={(e) => { const l = [...inputsList]; l[i].type = e.target.value; setInputsList(l); setIsDirty(true); }}
                className="text-xs font-medium rounded-full px-2.5 py-0.5 border-none outline-none cursor-pointer"
                style={{ background: tc.bg, color: tc.color }}
            >
                <option value="string">string</option>
                <option value="number">number</option>
                <option value="boolean">boolean</option>
                <option value="object">object</option>
                <option value="array">array</option>
                <option value="any">any</option>
            </select>
            {inp.secure && (
                /* nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret -- a translated field label or i18n key, not a credential */
                <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: 'rgba(239, 68, 68, 0.12)', color: '#f87171' }}>{t('component_studio.builder.secret', 'secret')}</span>
            )}
            <div className="ml-auto flex items-center gap-1">
                <button
                    onClick={() => { const l = [...inputsList]; l[i].secure = !l[i].secure; setInputsList(l); setIsDirty(true); }}
                    className="p-1.5 rounded-lg transition-all"
                    style={{
                        background: inp.secure ? 'rgba(239, 68, 68, 0.15)' : 'transparent',
                        color: inp.secure ? '#ef4444' : 'var(--text-muted)',
                    }}
                    /* nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret -- a translated field label or i18n key, not a credential */
                    title={inp.secure ? t('component_studio.builder.secret_marked', 'Marked as secret — click to toggle') : t('component_studio.builder.secret_mark', 'Click to mark as secret')}
                >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        {inp.secure ? (
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                        ) : (
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" />
                        )}
                    </svg>
                </button>
                <button
                    onClick={() => { setInputsList(inputsList.filter((_, j) => j !== i)); setIsDirty(true); }}
                    className="p-1.5 rounded-lg transition-all opacity-0 group-hover/card:opacity-100 hover:bg-red-500/20"
                    style={{ color: 'var(--text-muted)' }}
                    title={t('component_studio.builder.remove_input', 'Remove input')}
                >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                </button>
            </div>
        </div>
    );
}

function InputCardFields({ inp, i, draft }: { inp: InputRow; i: number; draft: DraftInputs }) {
    const { t } = useTranslation();
    const { inputsList, setInputsList, setIsDirty } = draft;
    return (
        <div className="flex gap-2.5 px-3.5 pb-3 pt-1">
            <div className="flex-shrink-0" style={{ width: '150px' }}>
                <label className="text-xs font-medium block mb-1" style={smallLabelStyle}>{t('component_studio.builder.default', 'Default')}</label>
                <input
                    type={inp.secure ? 'password' : 'text'}
                    value={inp.defaultValue || ''}
                    onChange={(e) => { const l = [...inputsList]; l[i].defaultValue = e.target.value; l[i]._hasStoredValue = false; setInputsList(l); setIsDirty(true); }}
                    placeholder={inp.secure ? (inp._hasStoredValue ? t('component_studio.builder.stored_placeholder', '••• stored') : '—') : '—'}
                    className="input w-full text-xs font-mono"
                />
            </div>
            <div className="flex-1">
                <label className="text-xs font-medium block mb-1" style={smallLabelStyle}>{t('component_studio.builder.description', 'Description')}</label>
                <div className="relative">
                    <input
                        type="text"
                        value={inp.description || ''}
                        onChange={(e) => { const l = [...inputsList]; l[i].description = e.target.value.slice(0, 150); setInputsList(l); setIsDirty(true); }}
                        placeholder={t('component_studio.builder.input_description_placeholder', 'Describe this input for AI agents...')}
                        className="input w-full text-xs pr-12"
                        maxLength={150}
                    />
                    {(inp.description || '').length > 0 && (
                        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-muted" style={{ fontSize: '9px' }}>
                            {(inp.description || '').length}/150
                        </span>
                    )}
                </div>
            </div>
        </div>
    );
}

export default function InputsSection({ draft }: { draft: DraftInputs }) {
    const { t } = useTranslation();
    const { inputsList, setInputsList } = draft;
    return (
        <div className="rounded-xl p-5" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)' }}>
            <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: 'rgba(34, 197, 94, 0.15)' }}>
                        <svg className="w-4 h-4" style={{ color: '#22c55e' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 16l-4-4m0 0l4-4m-4 4h14" />
                        </svg>
                    </div>
                    <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{t('component_studio.builder.inputs', 'Inputs')}</h3>
                    <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}>
                        {inputsList.length}
                    </span>
                </div>
                <button
                    onClick={() => setInputsList([...inputsList, { key: '', type: 'string', defaultValue: '', description: '', secure: false, _hasStoredValue: false }])}
                    className="btn-secondary text-xs"
                >
                    {t('component_studio.builder.add_input', '+ Add Input')}
                </button>
            </div>
            {inputsList.length === 0 ? (
                <p className="text-sm text-muted">{t('component_studio.builder.no_inputs', 'No inputs defined. Click "Add Input" to create one.')}</p>
            ) : (
                <div className="space-y-2.5">
                    {inputsList.map((inp, i) => {
                        const tc = typeColors[inp.type] || typeColors.any;
                        return (
                            <div key={i} className="rounded-xl overflow-hidden transition-all group/card" style={{
                                background: 'var(--bg-primary)',
                                border: '1px solid var(--border-subtle)',
                                borderLeft: `3px solid ${tc.color}`,
                            }}>
                                {/* Top row: name, type badge, actions */}
                                <InputCardHeader inp={inp} i={i} tc={tc} draft={draft} />
                                {/* Bottom row: default value + description */}
                                <InputCardFields inp={inp} i={i} draft={draft} />
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
