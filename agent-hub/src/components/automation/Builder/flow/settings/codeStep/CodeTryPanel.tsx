// "Try it": run the code once with values typed here. Every call to the
// outside is recorded and answered with a placeholder, so nothing is sent;
// the result, the log lines and what it WOULD have called come back.
import { Loader2, Play } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useCodeTest, type CodeParam, type CodeTestResult } from '../../../../../../api/queries/automation/codeStep';
import { useTranslation } from '../../../../../../hooks/useTranslation';
import type { InputsMap } from './codeParams';

/** A starting value per input: the literal typed in the form, else the default, else empty. */
export function tryValuesFrom(params: CodeParam[], inputs: InputsMap, otherNames: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    const literal = (name: string) => {
        const b = inputs[name];
        return b && b.kind === 'literal' && b.value != null ? b.value : undefined;
    };
    const asText = (v: unknown) => (v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v));
    for (const p of params) out[p.name] = asText(literal(p.name) ?? p.default);
    for (const n of otherNames) if (!(n in out)) out[n] = asText(literal(n));
    return out;
}

/** What the text boxes hold, as inputs: blanks left out (so defaults apply), JSON-looking text parsed. */
export function inputsFromValues(values: Record<string, string>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, raw] of Object.entries(values)) {
        const v = raw.trim();
        if (!v) continue;
        if (/^[[{]/.test(v)) { try { out[k] = JSON.parse(v); continue; } catch { /* keep the text */ } }
        out[k] = raw;
    }
    return out;
}

function Result({ r }: { r: CodeTestResult }) {
    const { t } = useTranslation();
    return (
        <div className="space-y-2 text-xs" data-testid="code-try-result">
            {r.error
                ? <p className="rounded-md border border-[var(--error)] p-2 text-[var(--error)] whitespace-pre-wrap">{r.error}</p>
                : <pre className="max-h-48 overflow-auto rounded-md bg-[var(--bg-tertiary)] p-2 font-mono custom-scrollbar">{JSON.stringify(r.result, null, 2)}</pre>}
            {r.calls.length > 0 && (
                <div>
                    <p className="font-medium text-[var(--text-primary)]">{t('code_step.try.would_have_called', 'Would have called (nothing was sent)')}</p>
                    <ul className="mt-1 space-y-0.5 font-mono text-[var(--text-secondary)]">{r.calls.map((c, i) => <li key={i}>{c.kind} · {c.name}</li>)}</ul>
                </div>
            )}
            {r.logs.length > 0 && (
                <div>
                    <p className="font-medium text-[var(--text-primary)]">{t('code_step.try.logs', 'Log')}</p>
                    <pre className="mt-1 max-h-32 overflow-auto rounded-md bg-[var(--bg-tertiary)] p-2 font-mono custom-scrollbar">{r.logs.join('\n')}</pre>
                </div>
            )}
            {r.durationMs != null && <p className="text-[var(--text-tertiary)]">{t('code_step.try.took', 'Took {ms} ms', { ms: r.durationMs })}</p>}
        </div>
    );
}

interface CodeTryPanelProps {
    code: string;
    params: CodeParam[];
    inputs: InputsMap;
    otherInputs: string[];
    allowedTools: string[];
    allowedHosts: string[];
    automationId: string | null;
    blocked: boolean;
}

export default function CodeTryPanel({ code, params, inputs, otherInputs, allowedTools, allowedHosts, automationId, blocked }: CodeTryPanelProps) {
    const { t } = useTranslation();
    const initial = useMemo(() => tryValuesFrom(params, inputs, otherInputs), [params, inputs, otherInputs]);
    const [values, setValues] = useState<Record<string, string>>({});
    const shown = { ...initial, ...values };
    const test = useCodeTest();
    const names = Object.keys(shown);
    const labelOf = (n: string) => params.find((p) => p.name === n)?.label || n;

    return (
        <div className="space-y-3 p-3" data-testid="code-try-panel">
            <p className="text-xs text-[var(--text-secondary)]">{t('code_step.try.hint', 'Runs the code once with these values. Calls to the web and to apps are only recorded, never sent.')}</p>
            {names.length > 0 && (
                <div className="grid grid-cols-1 gap-2 @[560px]/codeeditor:grid-cols-2">
                    {names.map((n) => (
                        <label key={n} className="flex flex-col gap-1 text-xs">
                            <span className="text-[var(--text-secondary)]">{labelOf(n)}</span>
                            <input
                                value={shown[n]}
                                placeholder={inputs[n]?.kind === 'ref' ? t('code_step.try.from_step', 'Comes from an earlier step: paste a sample') : undefined}
                                onChange={(e) => setValues((v) => ({ ...v, [n]: e.target.value }))}
                                className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-2 py-1 font-mono outline-none focus:border-[var(--accent-primary)]"
                            />
                        </label>
                    ))}
                </div>
            )}
            <button
                type="button"
                disabled={!code.trim() || test.isPending || blocked}
                onClick={() => test.mutate({ code, inputs: inputsFromValues(shown), allowedTools, allowedHosts, automationId })}
                className="inline-flex items-center gap-1.5 rounded-md bg-[var(--accent-primary)] px-3 py-1.5 text-xs font-medium text-[var(--accent-primary-fg)] disabled:opacity-40"
                data-testid="code-try-run"
            >
                {test.isPending ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Play size={13} aria-hidden="true" />}
                {t('code_step.try.run', 'Try it')}
            </button>
            {blocked && <p className="text-xs text-[var(--error)]">{t('code_step.try.blocked', 'Fix the checks marked "cannot run" first.')}</p>}
            {test.data && <Result r={test.data} />}
            {test.isError && <p className="text-xs text-[var(--error)]">{t('code_step.try.failed', 'The test run could not start. Try again in a moment.')}</p>}
        </div>
    );
}
