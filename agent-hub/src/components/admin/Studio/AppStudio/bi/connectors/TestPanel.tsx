import { AlertTriangle, CheckCircle2, Loader2, Plug } from 'lucide-react';
import { useState } from 'react';
import { postConnector } from './connectorHttp';
import { INPUT, LABEL, previewGrid, testFailureMessage } from './connectorModel';
import type { Connector } from './connectorModel';
import useTranslation from '../../../../../../hooks/useTranslation';
import { messageOf } from '../../../../../../utils/caughtError';

type TestResult = { status: 'running' } | { status: 'done'; rows: unknown[] } | { status: 'error'; message: string };

function PreviewTable({ rows }: { rows: unknown[] }) {
    const grid = previewGrid(rows);
    return (
        <div className="overflow-x-auto rounded-md border border-[var(--border-default)]">
            <table className="w-full text-left text-xs">
                <thead>
                    <tr>
                        {grid.columns.map((c) => (
                            <th key={c} className="px-2 py-1 font-medium text-[var(--text-secondary)]">{c}</th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {grid.cells.map((row, i) => (
                        <tr key={i}>
                            {grid.columns.map((c) => (
                                <td key={c} className="px-2 py-1 text-[var(--text-primary)]">{row[c]}</td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function TestOutcome({ result }: { result: TestResult | null }) {
    const { t } = useTranslation();
    if (result?.status === 'error') {
        return (
            <p
                role="alert"
                className="flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-xs"
                style={{ borderColor: 'color-mix(in srgb, var(--error) 40%, transparent)', background: 'color-mix(in srgb, var(--error) 10%, transparent)', color: 'var(--error)' }}
            >
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>{result.message}</span>
            </p>
        );
    }
    if (result?.status !== 'done') return null;
    return (
        <div className="flex flex-col gap-1.5">
            <p className="flex items-start gap-1.5 text-xs" style={{ color: result.rows.length ? '#10b981' : 'var(--text-secondary)' }}>
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>
                    {result.rows.length
                        ? (result.rows.length === 1
                            ? t('studio_apps_bi.connectors.test_works_one', 'It works — 1 row came back.')
                            : t('studio_apps_bi.connectors.test_works_many', 'It works — {n} rows came back.', { n: result.rows.length }))
                        : t('studio_apps_bi.connectors.test_works_empty', 'It works, but nothing came back. Check the pinned arguments or try other values.')}
                </span>
            </p>
            {result.rows.length ? <PreviewTable rows={result.rows} /> : null}
        </div>
    );
}

interface TestPanelProps {
    connector: Connector;
    appId: string | null;
    disabled?: boolean;
    problem: string | null;
}

/**
 * Run the connector and show what came back. The route reads the SAVED model,
 * so this is also the only place that can tell the author their draft has never
 * reached the server (a 404 for an id that exists right here on screen).
 */
export default function TestPanel({ connector, appId, disabled, problem }: TestPanelProps) {
    const { t } = useTranslation();
    const [values, setValues] = useState<Record<string, string>>({});
    const [result, setResult] = useState<TestResult | null>(null);
    const params = (Array.isArray(connector.params) ? connector.params : []).filter((p) => p && p.key) as Array<{ key: string }>;

    const run = async () => {
        setResult({ status: 'running' });
        try {
            const res = await postConnector(appId as string, connector.id, 'run', JSON.stringify({ params: values }));
            let body = null;
            try { body = await res.json(); } catch { body = null; }
            if (!res.ok) { setResult({ status: 'error', message: testFailureMessage(res.status, body, t) }); return; }
            setResult({ status: 'done', rows: Array.isArray(body?.rows) ? body.rows : [] });
        } catch (e) {
            setResult({ status: 'error', message: messageOf(e, t('studio_apps_bi.sync.err_unreachable', 'Could not reach the server.')) });
        }
    };

    return (
        <div className="flex flex-col gap-2 border-t pt-3 border-[var(--border-default)]">
            {params.length ? (
                <div className="flex flex-wrap items-end gap-2">
                    <span className={LABEL}>{t('studio_apps_bi.connectors.try_with', 'Try it with')}</span>
                    {params.map((p) => (
                        <input
                            key={p.key}
                            className={`${INPUT} w-40`}
                            value={values[p.key] ?? ''}
                            onChange={(e) => setValues({ ...values, [p.key]: e.target.value })}
                            placeholder={p.key}
                            aria-label={t('studio_apps_bi.connectors.test_value', 'Test value for {key}', { key: p.key })}
                            disabled={disabled}
                            spellCheck={false}
                        />
                    ))}
                </div>
            ) : null}
            <div className="flex items-center gap-2">
                <button
                    type="button"
                    onClick={run}
                    disabled={disabled || !appId || !!problem || result?.status === 'running'}
                    className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium disabled:opacity-50 border-[var(--border-default)] text-[var(--text-primary)]"
                >
                    {result?.status === 'running'
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                        : <Plug className="h-3.5 w-3.5" aria-hidden="true" />}
                    {t('studio_apps_bi.connectors.test_it', 'Test it')}
                </button>
                <span className="text-xs text-[var(--text-tertiary)]">
                    {!appId
                        ? t('studio_apps_bi.connectors.test_open_app', 'Open the app to test this.')
                        : problem
                            ? t('studio_apps_bi.connectors.test_finish_first', 'Finish the connector first.')
                            : t('studio_apps_bi.connectors.test_hint', 'Runs the last saved version and shows what comes back.')}
                </span>
            </div>
            <TestOutcome result={result} />
        </div>
    );
}
