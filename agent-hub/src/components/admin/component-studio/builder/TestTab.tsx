// The builder's Test tab: the input JSON, a run button, the output (or the
// error) and, after a successful run, copy and "save as sample output".

import { useTranslation } from '../../../../hooks/useTranslation';
import Editor from './LazyEditor';
import { defaultTestInput } from './componentForm';
import type { ComponentDraft } from './useComponentDraft';
import type { TestOutput } from './componentForm';

const monoFont = "'JetBrains Mono', 'Fira Code', Consolas, monospace";
const panelHeader = 'flex items-center justify-between mb-3 px-1';
const smallButtonStyle = { background: 'var(--bg-tertiary)', color: 'var(--text-muted)' };
const titleStyle = { color: 'var(--text-primary)' };
const editorBoxStyle = { borderColor: 'var(--border-default)' };
const placeholderStyle = { background: '#1e1e1e' };

function TestInputPanel({ draft }: { draft: ComponentDraft }) {
    const { t } = useTranslation();
    const { testInput, setTestInput, inputsList } = draft;
    return (
        <div className="flex-1 flex flex-col min-h-0">
            <div className={panelHeader}>
                <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full" style={{ background: '#22c55e' }} />
                    <span className="text-sm font-medium" style={titleStyle}>{t('component_studio.builder.input_json', 'Input (JSON)')}</span>
                </div>
                <button
                    onClick={() => setTestInput(defaultTestInput(inputsList))}
                    className="text-xs px-2 py-1 rounded transition-colors"
                    style={smallButtonStyle}
                >
                    {t('component_studio.builder.reset_defaults', 'Reset to defaults')}
                </button>
            </div>
            <div className="flex-1 rounded-xl overflow-hidden border" style={editorBoxStyle}>
                <Editor
                    height="100%"
                    defaultLanguage="json"
                    theme="vs-dark"
                    value={testInput}
                    onChange={(value) => setTestInput(value || '')}
                    options={{
                        fontSize: 13,
                        fontFamily: monoFont,
                        minimap: { enabled: false },
                        scrollBeyondLastLine: false,
                        padding: { top: 12, bottom: 12 },
                        lineNumbers: 'off',
                        renderLineHighlight: 'none',
                        automaticLayout: true,
                        tabSize: 2,
                        wordWrap: 'on',
                        folding: false
                    }}
                />
            </div>
        </div>
    );
}

function TestOutputHeader({ testOutput, onSaveSample }: { testOutput: TestOutput | null; onSaveSample: () => void }) {
    const { t } = useTranslation();
    return (
        <div className={panelHeader}>
            <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full" style={{ background: testOutput?.error ? '#ef4444' : '#a855f7' }} />
                <span className="text-sm font-medium" style={titleStyle}>{t('component_studio.builder.output', 'Output')}</span>
                {testOutput && !testOutput.error && (
                    <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: 'rgba(34, 197, 94, 0.2)', color: '#22c55e' }}>{t('component_studio.builder.success', 'Success')}</span>
                )}
                {(testOutput?.error as string | undefined) && (
                    <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: 'rgba(239, 68, 68, 0.2)', color: '#ef4444' }}>{t('component_studio.builder.error', 'Error')}</span>
                )}
            </div>
            <div className="flex items-center gap-2">
                {testOutput && !testOutput.error && (
                    <>
                        <button
                            onClick={() => navigator.clipboard.writeText(JSON.stringify(testOutput, null, 2))}
                            className="text-xs px-2 py-1 rounded transition-colors"
                            style={smallButtonStyle}
                            title={t('component_studio.builder.copy_title', 'Copy to clipboard')}
                        >
                            {t('component_studio.builder.copy', '📋 Copy')}
                        </button>
                        <button
                            onClick={onSaveSample}
                            className="text-xs px-2 py-1 rounded transition-colors"
                            style={{ background: 'rgba(99, 102, 241, 0.2)', color: '#6366f1' }}
                            title={t('component_studio.builder.save_sample_title', 'Save as sample output')}
                        >
                            {t('component_studio.builder.save_sample', '💾 Save Sample')}
                        </button>
                    </>
                )}
            </div>
        </div>
    );
}

function TestOutputBody({ testOutput, isTesting }: { testOutput: TestOutput | null; isTesting: boolean }) {
    const { t } = useTranslation();
    if (isTesting) {
        return (
            <div className="h-full flex items-center justify-center" style={placeholderStyle}>
                <div className="flex items-center gap-3" style={{ color: 'var(--text-muted)' }}>
                    <div className="spinner" style={{ width: '1.25rem', height: '1.25rem' }}></div>
                    <span>{t('component_studio.builder.running_component', 'Running component...')}</span>
                </div>
            </div>
        );
    }
    if (testOutput) {
        return (
            <Editor
                height="100%"
                defaultLanguage="json"
                theme="vs-dark"
                value={JSON.stringify(testOutput, null, 2)}
                options={{
                    fontSize: 13,
                    fontFamily: monoFont,
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    padding: { top: 12, bottom: 12 },
                    lineNumbers: 'off',
                    renderLineHighlight: 'none',
                    automaticLayout: true,
                    readOnly: true,
                    wordWrap: 'on',
                    folding: true
                }}
            />
        );
    }
    return (
        <div className="h-full flex items-center justify-center" style={placeholderStyle}>
            <span style={{ color: 'var(--text-muted)' }}>{t('component_studio.builder.run_hint', 'Click "Run Test" to execute the component')}</span>
        </div>
    );
}

function RunBar({ isTesting, isCreating, onRun }: { isTesting: boolean; isCreating: boolean; onRun: () => void }) {
    const { t } = useTranslation();
    const blocked = isTesting || isCreating;
    return (
        <div className="flex justify-center pt-2">
            <button
                onClick={onRun}
                disabled={blocked}
                className="px-8 py-2.5 rounded-xl font-medium transition-all flex items-center gap-2"
                style={{
                    background: blocked ? 'var(--bg-tertiary)' : 'linear-gradient(135deg, #22c55e, #16a34a)',
                    color: blocked ? 'var(--text-muted)' : 'white',
                    cursor: blocked ? 'not-allowed' : 'pointer'
                }}
            >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
                {isTesting ? t('component_studio.builder.running', 'Running...') : t('component_studio.builder.run_test', 'Run Test')}
            </button>
            {isCreating && (
                <p className="text-xs ml-4 self-center" style={{ color: 'var(--text-muted)' }}>{t('component_studio.builder.save_first', 'Save the component first to test it')}</p>
            )}
        </div>
    );
}

interface TestTabProps {
    draft: ComponentDraft;
    isCreating: boolean;
    onRun: () => void;
    onSaveSample: () => void;
}

export default function TestTab({ draft, isCreating, onRun, onSaveSample }: TestTabProps) {
    const { testOutput, isTesting } = draft;
    return (
        <div className="h-full flex flex-col p-4 gap-4">
            <div className="flex-1 flex gap-4 min-h-0">
                {/* Test Input */}
                <TestInputPanel draft={draft} />

                {/* Test Output */}
                <div className="flex-1 flex flex-col min-h-0">
                    <TestOutputHeader testOutput={testOutput} onSaveSample={onSaveSample} />
                    <div className="flex-1 rounded-xl overflow-hidden border" style={editorBoxStyle}>
                        <TestOutputBody testOutput={testOutput} isTesting={isTesting} />
                    </div>
                </div>
            </div>

            <RunBar isTesting={isTesting} isCreating={isCreating} onRun={onRun} />
        </div>
    );
}
