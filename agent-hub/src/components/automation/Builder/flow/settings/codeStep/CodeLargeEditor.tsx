// The large code editor: the code on the left; on the right the AI
// assistant, the parameters form and the checks; "Try it" under the code.
//
// It edits the same draft as the drawer (the drawer's autosave writes it), so
// closing it loses nothing. Folds by its own width: below ~1100px the right
// column is shown INSTEAD of the code, switched from the header, rather than
// squeezing both side by side.
import { Ban, ChevronDown, ChevronRight, Code2, ShieldCheck, Sparkles, SlidersHorizontal, X } from 'lucide-react';
import { useCallback, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { CodeFinding } from '../../../../../../api/queries/automation/codeStep';
import { useTranslation } from '../../../../../../hooks/useTranslation';
import CodeAssistPanel from './CodeAssistPanel';
import CodeChecksPanel from './CodeChecksPanel';
import CodeEditorField, { type CodeEditorHandle } from './CodeEditorField';
import CodeParamsForm from './CodeParamsForm';
import type { InputsMap } from './codeParams';
import CodeTryPanel from './CodeTryPanel';
import { useCodeAssistChat } from './useCodeAssistChat';
import type { StepCodeAnalysis } from './useStepCodeAnalysis';

export type LargeEditorTab = 'assistant' | 'params' | 'checks';

interface CodeLargeEditorProps {
    initialTab: LargeEditorTab;
    onClose: () => void;
    draft: { code?: string; inputs?: InputsMap; allowedHosts?: string[] };
    set: (key: string, value: unknown) => void;
    state: StepCodeAnalysis;
    stepLabel: string;
    automationId: string | null;
    stepId: string | null;
    allowedTools: string[];
    upstreamFields: Array<{ path: string; label: string; type: string }>;
    onFocusField?: unknown;
}

const TABS: Array<[LargeEditorTab, string, string, typeof Sparkles]> = [
    ['assistant', 'code_step.large.tab_assistant', 'Assistant', Sparkles],
    ['params', 'code_step.large.tab_params', 'Parameters', SlidersHorizontal],
    ['checks', 'code_step.large.tab_checks', 'Checks', ShieldCheck],
];

export default function CodeLargeEditor({ initialTab, onClose, draft, set, state, stepLabel, automationId, stepId, allowedTools, upstreamFields, onFocusField = null }: CodeLargeEditorProps) {
    const { t } = useTranslation();
    const [tab, setTab] = useState<LargeEditorTab>(initialTab);
    const [smallView, setSmallView] = useState<'code' | 'panel'>('panel');
    const [tryOpen, setTryOpen] = useState(false);
    const [prefill, setPrefill] = useState<{ text: string; nonce: number } | null>(null);
    const editorRef = useRef<CodeEditorHandle | null>(null);
    const code = draft.code || '';
    const allowedHosts = draft.allowedHosts || [];
    const analysis = state.analysis;
    const findings = analysis?.findings || [];
    const blocks = findings.filter((f) => f.severity === 'block').length + (analysis?.syntaxError ? 1 : 0);
    const params = analysis?.params || [];

    const chat = useCodeAssistChat({
        code, setCode: (c) => set('code', c), allowedTools, allowedHosts, upstreamFields, automationId, stepId,
    });

    const focusRef = useCallback((el: HTMLDivElement | null) => { el?.focus(); }, []);
    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        if (e.key !== 'Escape') return;
        // Monaco uses Escape for its own widgets (suggestions, find).
        if ((e.target as HTMLElement).closest?.('.monaco-editor')) return;
        e.stopPropagation();
        onClose();
    };
    const openTab = (next: LargeEditorTab) => { setTab(next); setSmallView('panel'); };
    const jump = (line: number, column: number) => { setSmallView('code'); editorRef.current?.revealLine(line, column); };
    const fixWithBee = (f: CodeFinding) => {
        const message = f.messageKey ? t(f.messageKey, f.message) : f.message;
        setPrefill({ text: t('code_step.assist.fix_prompt', 'Fix this check on line {line}: {message}', { line: f.line, message }), nonce: Date.now() });
        openTab('assistant');
    };

    const body = (
        <div className="fixed inset-0 z-[1100] bg-black/30 flex items-center justify-center p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
            <div
                ref={focusRef}
                tabIndex={-1}
                role="dialog"
                aria-modal="true"
                aria-label={t('code_step.large.title', 'Code · {step}', { step: stepLabel || t('code_step.large.untitled', 'Code step') })}
                onKeyDown={onKeyDown}
                className="@container/codeeditor w-full max-w-[2000px] h-[calc(100vh-32px)] max-h-[1200px] rounded-xl overflow-hidden shadow-2xl bg-[var(--bg-card)] text-[var(--text-primary)] flex flex-col outline-none"
                data-testid="code-large-editor"
            >
                <header className="h-12 shrink-0 flex items-center gap-3 px-4 border-b border-[var(--border-subtle)]">
                    <Code2 size={16} aria-hidden="true" />
                    <h2 className="text-sm font-semibold truncate">{stepLabel || t('code_step.large.untitled', 'Code step')}</h2>
                    {blocks > 0
                        ? <span className="inline-flex items-center gap-1 rounded-full bg-[var(--error)]/10 px-2 py-0.5 text-xs text-[var(--error)]"><Ban size={11} aria-hidden="true" />{t('code_step.large.cannot_run', 'Cannot run yet')}</span>
                        : analysis && <span className="inline-flex items-center gap-1 rounded-full bg-[var(--success)]/10 px-2 py-0.5 text-xs text-[var(--success)] @max-[700px]/codeeditor:hidden"><ShieldCheck size={11} aria-hidden="true" />{t('code_step.large.checked', 'Checked')}</span>}
                    <div className="ml-auto flex items-center gap-1 @min-[1100px]/codeeditor:hidden" role="group" aria-label={t('code_step.large.view', 'View')}>
                        <button type="button" aria-pressed={smallView === 'code'} onClick={() => setSmallView('code')} className={`rounded-md px-2.5 py-1 text-xs ${smallView === 'code' ? 'bg-[var(--bg-tertiary)] font-medium' : 'text-[var(--text-secondary)]'}`}>{t('code_step.large.view_code', 'Code')}</button>
                        <button type="button" aria-pressed={smallView === 'panel'} onClick={() => setSmallView('panel')} className={`rounded-md px-2.5 py-1 text-xs ${smallView === 'panel' ? 'bg-[var(--bg-tertiary)] font-medium' : 'text-[var(--text-secondary)]'}`}>{t(TABS.find((x) => x[0] === tab)![1], TABS.find((x) => x[0] === tab)![2])}</button>
                    </div>
                    <button type="button" onClick={onClose} aria-label={t('code_step.large.close', 'Close')} className="ml-auto @max-[1099px]/codeeditor:ml-0 grid h-8 w-8 place-items-center rounded-md hover:bg-[var(--bg-tertiary)]"><X size={16} aria-hidden="true" /></button>
                </header>
                <div className="flex-1 min-h-0 grid grid-cols-[minmax(0,1fr)_440px] @min-[1700px]/codeeditor:grid-cols-[minmax(0,1fr)_520px] @max-[1099px]/codeeditor:grid-cols-1">
                    <section className={`flex min-h-0 min-w-0 flex-col ${smallView === 'panel' ? '@max-[1099px]/codeeditor:hidden' : ''}`} aria-label={t('code_step.large.view_code', 'Code')}>
                        <div className="flex-1 min-h-0 p-2">
                            <CodeEditorField value={code} onChange={(v) => set('code', v)} analysis={analysis} handleRef={editorRef} fill />
                        </div>
                        <div className="shrink-0 border-t border-[var(--border-subtle)] max-h-[45%] overflow-auto custom-scrollbar">
                            <button type="button" aria-expanded={tryOpen} onClick={() => setTryOpen((o) => !o)} className="flex w-full items-center gap-1.5 px-3 py-2 text-xs font-medium text-[var(--text-primary)]" data-testid="code-try-toggle">
                                {tryOpen ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
                                {t('code_step.try.title', 'Try it')}
                                <span className="font-normal text-[var(--text-tertiary)]">{t('code_step.try.subtitle', 'nothing is sent')}</span>
                            </button>
                            {tryOpen && (
                                <CodeTryPanel
                                    code={code}
                                    params={params}
                                    inputs={draft.inputs || {}}
                                    otherInputs={analysis?.capabilities.undeclaredInputs || []}
                                    allowedTools={allowedTools}
                                    allowedHosts={allowedHosts}
                                    automationId={automationId}
                                    blocked={blocks > 0}
                                />
                            )}
                        </div>
                    </section>
                    <aside className={`flex min-h-0 flex-col border-l border-[var(--border-subtle)] @max-[1099px]/codeeditor:border-l-0 ${smallView === 'code' ? '@max-[1099px]/codeeditor:hidden' : ''}`}>
                        <div role="tablist" className="flex shrink-0 gap-1 border-b border-[var(--border-subtle)] px-2 pt-2">
                            {TABS.map(([id, key, english, Icon]) => (
                                <button
                                    key={id}
                                    type="button"
                                    role="tab"
                                    aria-selected={tab === id}
                                    onClick={() => openTab(id)}
                                    className={`inline-flex items-center gap-1.5 rounded-t-md px-3 py-2 text-xs ${tab === id ? 'border-b-2 border-[var(--accent-primary)] font-medium text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
                                >
                                    <Icon size={13} aria-hidden="true" />{t(key, english)}
                                    {id === 'checks' && findings.some((f) => f.severity !== 'info') && <span className="h-1.5 w-1.5 rounded-full bg-[var(--warning)]" aria-hidden="true" />}
                                </button>
                            ))}
                        </div>
                        <div className="flex-1 min-h-0" role="tabpanel">
                            {tab === 'assistant' && (
                                <CodeAssistPanel turns={chat.turns} busy={chat.busy} codeIsEmpty={!code.trim()} onSend={chat.send} onStop={chat.stop} onKeep={chat.keep} onUndo={chat.undo} prefill={prefill} />
                            )}
                            {tab === 'params' && (
                                <div className="h-full min-h-0 space-y-3 overflow-auto p-3 custom-scrollbar">
                                    {analysis?.description && <p className="text-sm">{analysis.description}</p>}
                                    {params.length > 0
                                        ? <CodeParamsForm params={params} inputs={draft.inputs || {}} onChange={(next) => set('inputs', next)} inputsRead={analysis?.capabilities.inputsRead || []} onFocusField={onFocusField} />
                                        : (
                                            <div className="space-y-2 text-sm text-[var(--text-secondary)]">
                                                <p>{t('code_step.params.none', 'This code declares no parameters yet. Describe each input above main() and a form appears here for whoever uses the step:')}</p>
                                                <pre className="rounded-md bg-[var(--bg-tertiary)] p-2 font-mono text-xs">{'/**\n * @param {number} amount - The amount without VAT\n */'}</pre>
                                                <button type="button" onClick={() => { setPrefill({ text: t('code_step.assist.describe_inputs', 'Describe every input this code uses with a @param line and a short explanation.'), nonce: Date.now() }); openTab('assistant'); }} className="inline-flex items-center gap-1 text-xs font-medium text-[var(--accent-primary)]">
                                                    <Sparkles size={12} aria-hidden="true" />{t('code_step.params.ask_bee', 'Let Bee describe the inputs')}
                                                </button>
                                            </div>
                                        )}
                                </div>
                            )}
                            {tab === 'checks' && (
                                <CodeChecksPanel analysis={analysis} reading={state.reading} failed={state.failed} allowedHosts={allowedHosts} onHosts={(next) => set('allowedHosts', next)} onJump={jump} onFix={fixWithBee} />
                            )}
                        </div>
                    </aside>
                </div>
            </div>
        </div>
    );
    return typeof document !== 'undefined' ? createPortal(body, document.body) : body;
}
