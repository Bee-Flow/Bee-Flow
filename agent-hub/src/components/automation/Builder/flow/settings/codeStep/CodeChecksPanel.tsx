// The checks tab of the large code editor: what the automatic checks found,
// in plain sentences, with the line, a hint and "Fix with Bee"; and where the
// step may send data.
//
// Severity, as the runner applies it: a BLOCK finding stops the step (a draft
// still saves); a warning is shown, never enforced; info is a fact.
import { AlertTriangle, Ban, Info, Plus, ShieldCheck, Sparkles, X } from 'lucide-react';
import { useState } from 'react';
import type { CodeAnalysis, CodeFinding } from '../../../../../../api/queries/automation/codeStep';
import { useTranslation } from '../../../../../../hooks/useTranslation';
import CapabilityLine from './CapabilityLine';

const HOST_RE = /^(\*\.)?(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** A host as typed ("https://api.example.com/x", "API.example.com") to a list entry, or null. */
export function cleanHostEntry(raw: string): string | null {
    let s = String(raw || '').trim().toLowerCase();
    if (!s) return null;
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/\.$/, '');
    return HOST_RE.test(s) ? s : null;
}

function FindingRow({ f, onJump, onFix }: { f: CodeFinding; onJump: (line: number, column: number) => void; onFix: (f: CodeFinding) => void }) {
    const { t } = useTranslation();
    const Icon = f.severity === 'block' ? Ban : f.severity === 'warn' ? AlertTriangle : Info;
    const tone = f.severity === 'block' ? 'text-[var(--error)]' : f.severity === 'warn' ? 'text-[var(--warning)]' : 'text-[var(--text-secondary)]';
    return (
        <li className="rounded-md border border-[var(--border-subtle)] p-2.5 space-y-1.5" data-testid={`finding-${f.ruleId}`}>
            <div className="flex items-start gap-2">
                <Icon size={14} className={`mt-0.5 shrink-0 ${tone}`} aria-hidden="true" />
                <div className="min-w-0 space-y-1">
                    <p className="text-sm text-[var(--text-primary)]">{f.messageKey ? t(f.messageKey, f.message) : f.message}</p>
                    {f.fix && <p className="text-xs text-[var(--text-secondary)]">{f.fixKey ? t(f.fixKey, f.fix) : f.fix}</p>}
                    {f.severity === 'block' && <p className="text-xs font-medium text-[var(--error)]">{t('code_step.checks.blocks_run', 'This step cannot run until this is fixed.')}</p>}
                </div>
            </div>
            <div className="flex items-center gap-2 pl-6">
                <button type="button" onClick={() => onJump(f.line, f.column)} className="text-xs text-[var(--text-secondary)] underline underline-offset-2 hover:text-[var(--text-primary)]">
                    {t('code_step.checks.line', 'Line {line}', { line: f.line })}
                </button>
                {f.severity !== 'info' && (
                    <button type="button" onClick={() => onFix(f)} className="inline-flex items-center gap-1 text-xs font-medium text-[var(--accent-primary)]">
                        <Sparkles size={12} aria-hidden="true" />{t('code_step.checks.fix_with_bee', 'Fix with Bee')}
                    </button>
                )}
            </div>
        </li>
    );
}

function HostsEditor({ hosts, onChange }: { hosts: string[]; onChange: (next: string[]) => void }) {
    const { t } = useTranslation();
    const [text, setText] = useState('');
    const [bad, setBad] = useState(false);
    const add = () => {
        const h = cleanHostEntry(text);
        if (!h) { setBad(true); return; }
        if (!hosts.includes(h)) onChange([...hosts, h]);
        setText('');
        setBad(false);
    };
    return (
        <div className="space-y-2" data-testid="hosts-editor">
            <p className="text-xs font-medium text-[var(--text-primary)]">{t('code_step.hosts.title', 'Where this step may send data')}</p>
            <p className="text-xs text-[var(--text-secondary)]">{t('code_step.hosts.hint', 'Hosts the code names are allowed already. List the ones it only knows at run time; everything else is refused.')}</p>
            {hosts.length > 0 && (
                <ul className="flex flex-wrap gap-1.5">
                    {hosts.map((h) => (
                        <li key={h} className="inline-flex items-center gap-1 rounded-full border border-[var(--border-subtle)] px-2 py-0.5 font-mono text-xs">
                            {h}
                            <button type="button" onClick={() => onChange(hosts.filter((x) => x !== h))} aria-label={t('code_step.hosts.remove', 'Remove {host}', { host: h })}><X size={11} aria-hidden="true" /></button>
                        </li>
                    ))}
                </ul>
            )}
            <div className="flex gap-2">
                <input
                    value={text}
                    onChange={(e) => { setText(e.target.value); setBad(false); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
                    placeholder="api.example.com"
                    aria-label={t('code_step.hosts.input', 'Host to allow')}
                    aria-invalid={bad}
                    className="flex-1 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-2 py-1 font-mono text-xs outline-none focus:border-[var(--accent-primary)]"
                />
                <button type="button" onClick={add} className="inline-flex items-center gap-1 rounded-md border border-[var(--border-subtle)] px-2 py-1 text-xs"><Plus size={12} aria-hidden="true" />{t('code_step.hosts.add', 'Add')}</button>
            </div>
            {bad && <p className="text-xs text-[var(--error)]">{t('code_step.hosts.invalid', 'Type a host name such as api.example.com, or *.example.com for its sub-domains.')}</p>}
        </div>
    );
}

interface CodeChecksPanelProps {
    analysis: CodeAnalysis | null;
    reading: boolean;
    failed: boolean;
    allowedHosts: string[];
    onHosts: (next: string[]) => void;
    onJump: (line: number, column: number) => void;
    onFix: (f: CodeFinding) => void;
}

export default function CodeChecksPanel({ analysis, reading, failed, allowedHosts, onHosts, onJump, onFix }: CodeChecksPanelProps) {
    const { t } = useTranslation();
    const findings = analysis?.findings || [];
    const loud = findings.filter((f) => f.severity !== 'info');
    return (
        <div className="h-full min-h-0 space-y-4 overflow-auto p-3 custom-scrollbar" data-testid="code-checks-panel">
            {analysis?.syntaxError && (
                <p className="rounded-md border border-[var(--error)] p-2.5 text-sm text-[var(--error)]">
                    {t('code_step.checks.syntax', 'The code has a syntax error at line {line}: {message}', { line: analysis.syntaxError.line, message: analysis.syntaxError.message })}
                </p>
            )}
            {reading && !analysis && <p className="text-sm italic text-[var(--text-secondary)]">{t('code_step.reading', 'Reading the code…')}</p>}
            {failed && <p className="text-sm text-[var(--text-secondary)]">{t('code_step.checks.unavailable', 'The checks could not run just now. The step is still checked when it runs.')}</p>}
            {analysis && !analysis.syntaxError && loud.length === 0 && (
                <p className="inline-flex items-center gap-1.5 text-sm text-[var(--success)]"><ShieldCheck size={14} aria-hidden="true" />{t('code_step.checks.clean', 'The checks found nothing to worry about.')}</p>
            )}
            {findings.length > 0 && <ul className="space-y-2">{findings.map((f, i) => <FindingRow key={`${f.ruleId}-${f.line}-${i}`} f={f} onJump={onJump} onFix={onFix} />)}</ul>}
            {analysis && <CapabilityLine caps={analysis.capabilities} allowedHosts={allowedHosts} />}
            <HostsEditor hosts={allowedHosts} onChange={onHosts} />
            <p className="text-xs text-[var(--text-tertiary)]">{t('code_step.checks.note', 'The checks catch what honest code never needs. The code always runs in a closed sandbox, whatever the checks say.')}</p>
        </div>
    );
}
