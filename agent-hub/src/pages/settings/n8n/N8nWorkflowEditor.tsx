import { ChevronDown, ChevronRight, Plus, Trash2, X } from 'lucide-react';
import { useTranslation } from '../../../hooks/useTranslation';
import { INPUT_TYPES, type N8nWorkflow } from './n8nModel';
import type { N8nWorkflows } from './useN8nState';

const FIELD_STYLE = { borderColor: 'var(--border-default)', color: 'var(--text-primary)' };
const SWITCH_TRACK = "w-8 h-4 bg-gray-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-all";

/** The workflow's input parameters (name, type, description). */
function InputsEditor({ wf, wfs }: { wf: N8nWorkflow; wfs: N8nWorkflows }) {
    const { t } = useTranslation();
    const inputs = wf.inputs || [];
    return (
        <div>
            <div className="flex items-center justify-between mb-1">
                <label className="text-[11px] font-semibold text-[var(--text-secondary)]">{t('settings.n8n.input_parameters', 'Input Parameters')}</label>
                <button onClick={() => wfs.addInput(wf.id)}
                    className="flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded hover:opacity-80 text-[var(--accent-primary)]">
                    <Plus className="w-3 h-3" /> {t('settings.n8n.add', 'Add')}
                </button>
            </div>
            {inputs.length === 0 ? (
                <p className="text-[11px] py-1 text-[var(--text-muted)]">{t('settings.n8n.no_inputs', 'No inputs — AI sends freeform JSON.')}</p>
            ) : (
                <div className="space-y-1.5">
                    {inputs.map((inp, idx) => (
                        <div key={idx} className="flex items-center gap-1.5 p-1.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-primary)]">
                            <input type="text" value={inp.name} onChange={e => wfs.updateInput(wf.id, idx, { name: e.target.value })}
                                placeholder={t('settings.n8n.input_name_placeholder', 'name')} className="flex-1 px-1.5 py-0.5 text-[11px] rounded border bg-transparent outline-none"
                                style={FIELD_STYLE} />
                            <select value={inp.type} onChange={e => wfs.updateInput(wf.id, idx, { type: e.target.value })}
                                className="px-1 py-0.5 text-[11px] rounded border bg-transparent outline-none"
                                style={{ borderColor: 'var(--border-default)', color: 'var(--text-primary)', background: 'var(--bg-primary)' }}>
                                {INPUT_TYPES.map(inputType => <option key={inputType} value={inputType}>{inputType}</option>)}
                            </select>
                            <input type="text" value={inp.description} onChange={e => wfs.updateInput(wf.id, idx, { description: e.target.value })}
                                placeholder={t('settings.n8n.input_description_placeholder', 'description')} className="flex-[2] px-1.5 py-0.5 text-[11px] rounded border bg-transparent outline-none"
                                style={FIELD_STYLE} />
                            <button onClick={() => wfs.removeInput(wf.id, idx)}
                                className="p-0.5 rounded hover:bg-red-500/10 shrink-0 text-[var(--text-muted)]">
                                <X className="w-3 h-3" />
                            </button>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

/** The expanded editor of one workflow: name, slug, description, inputs, KB ingestion. */
function WorkflowDetails({ wf, wfs }: { wf: N8nWorkflow; wfs: N8nWorkflows }) {
    const { t } = useTranslation();
    const fieldClass = 'w-full px-2 py-1 text-xs rounded border bg-transparent outline-none focus:border-[var(--accent-primary)]';
    return (
        <div className="px-3 pb-3 space-y-2 border-t border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
            <div className="pt-2 grid grid-cols-2 gap-2">
                <div>
                    <label className="block text-[11px] font-medium mb-0.5 text-[var(--text-secondary)]">{t('settings.n8n.display_name', 'Display Name')}</label>
                    <input type="text" value={wf.name} onChange={e => wfs.updateWorkflow(wf.id, { name: e.target.value })}
                        className={fieldClass} style={FIELD_STYLE} />
                </div>
                <div>
                    <label className="block text-[11px] font-medium mb-0.5 text-[var(--text-secondary)]">{t('settings.n8n.tool_slug', 'Tool Slug')}</label>
                    <div className="flex items-center gap-1">
                        <span className="text-[11px] shrink-0 text-[var(--text-muted)]">n8n_run_</span>
                        <input type="text" value={wf.slug} onChange={e => wfs.updateWorkflow(wf.id, { slug: e.target.value.replace(/[^a-z0-9_]/g, '') })}
                            className={fieldClass} style={FIELD_STYLE} />
                    </div>
                </div>
            </div>
            <div>
                <label className="block text-[11px] font-medium mb-0.5 text-[var(--text-secondary)]">{t('settings.n8n.description_label', 'Description (shown to AI)')}</label>
                <input type="text" value={wf.description || ''} onChange={e => wfs.updateWorkflow(wf.id, { description: e.target.value })}
                    placeholder={t('settings.n8n.description_placeholder', 'Describe what this workflow does')}
                    className={fieldClass} style={FIELD_STYLE} />
            </div>
            <InputsEditor wf={wf} wfs={wfs} />
            {/* KB Ingestion */}
            <div className="pt-2 mt-1 border-t border-[var(--border-subtle)]">
                <div className="flex items-center justify-between p-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-primary)]">
                    <div className="text-[11px] text-[var(--text-muted)]">
                        📚 {t('settings.n8n.kb_allow', 'Allow agents to ingest this workflow into their Knowledge Base.')}
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer flex-shrink-0" onClick={e => e.stopPropagation()}>
                        <input type="checkbox" checked={!!wf.allowKbIngestion} onChange={() => wfs.toggleKbIngestion(wf.id)} className="sr-only peer" />
                        <div className={`${SWITCH_TRACK} peer-checked:bg-[var(--accent-primary)]`}></div>
                    </label>
                </div>
            </div>
        </div>
    );
}

/** One configured workflow: the summary row (expand, enable, remove) and its editor. */
export default function WorkflowRow({ wf, wfs }: { wf: N8nWorkflow; wfs: N8nWorkflows }) {
    const { t } = useTranslation();
    const isExpanded = wfs.expandedWf === wf.id;
    const chevronStyle = { color: 'var(--text-muted)' };
    return (
        <div>
            <div className="flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-[var(--bg-tertiary)] transition-colors"
                onClick={() => wfs.setExpandedWf(isExpanded ? null : wf.id)}>
                {isExpanded ? <ChevronDown className="w-3.5 h-3.5 shrink-0" style={chevronStyle} /> : <ChevronRight className="w-3.5 h-3.5 shrink-0" style={chevronStyle} />}
                <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate flex items-center gap-1.5 text-[var(--text-primary)]">
                        {wf.name}
                        {wf.allowKbIngestion && (
                            <span className="text-[9px] px-1 py-0.5 rounded font-medium flex-shrink-0" style={{ background: 'rgba(59,130,246,0.1)', color: '#3b82f6' }} title={t('settings.n8n.kb_enabled_title', 'Enabled for KB ingestion')}>📚 {t('settings.n8n.kb_badge', 'KB')}</span>
                        )}
                    </div>
                    <div className="text-[11px] truncate text-[var(--text-muted)]">
                        n8n_run_{wf.slug} · {t('settings.n8n.inputs_count', '{count} input(s)', { count: (wf.inputs || []).length })}
                    </div>
                </div>
                <label className="relative inline-flex items-center cursor-pointer flex-shrink-0" onClick={e => e.stopPropagation()}>
                    <input type="checkbox" checked={wf.enabled} onChange={() => wfs.updateWorkflow(wf.id, { enabled: !wf.enabled })} className="sr-only peer" />
                    <div className={`${SWITCH_TRACK} peer-checked:bg-emerald-500`}></div>
                </label>
                <button onClick={(e) => { e.stopPropagation(); wfs.removeWorkflow(wf.id); }}
                    className="p-1 rounded-lg hover:bg-red-500/10 transition-colors text-[var(--text-muted)]">
                    <Trash2 className="w-3.5 h-3.5" />
                </button>
            </div>
            {isExpanded && <WorkflowDetails wf={wf} wfs={wfs} />}
        </div>
    );
}
