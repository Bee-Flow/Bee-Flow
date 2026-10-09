// "Import cURL" dialog of the http_request editor: paste, preview, apply.
// The pasted text stays in local state only (never logged, never stored).
import { useMemo, useState } from 'react';
import { useTranslation } from '../../../../../../hooks/useTranslation';
import { inputClass } from '../formPrimitives';
import { parseCurl, type CurlImport } from './curlImport';

type Props = { open: boolean; onClose: () => void; onApply: (parsed: CurlImport) => void };

export function CurlImportDialog({ open, onClose, onApply }: Props) {
    const { t } = useTranslation();
    const [text, setText] = useState('');
    const parsed = useMemo(() => (text.trim() ? parseCurl(text) : null), [text]);
    if (!open) return null;

    const close = () => { setText(''); onClose(); };
    const headerNames = parsed ? Object.keys(parsed.headers) : [];

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" data-testid="curl-import-overlay">
            <div role="dialog" aria-modal="true" aria-label={t('http_query.curl_title', 'Import cURL')}
                className="w-full max-w-xl max-h-[90vh] overflow-y-auto rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-4 shadow-xl">
                <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-1">{t('http_query.curl_title', 'Import cURL')}</h3>
                <p className="text-xs text-[var(--text-tertiary)] mb-2">
                    {t('http_query.curl_hint', 'Paste a curl command, for example copied from an API manual or your browser. It fills in the method, address, parameters, headers and body.')}
                </p>
                <textarea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    rows={6}
                    spellCheck={false}
                    autoComplete="off"
                    aria-label={t('http_query.curl_input', 'curl command')}
                    placeholder={"curl -X POST https://api.example.com/items -H 'Content-Type: application/json' -d '{\"name\":\"x\"}'"}
                    className={inputClass() + ' font-mono text-xs'}
                />
                {text.trim() && !parsed && (
                    <div className="text-xs text-red-500 mt-2" role="alert">{t('http_query.curl_invalid', 'No web address found in this command.')}</div>
                )}
                {parsed && (
                    <div className="mt-3 space-y-2 text-xs text-[var(--text-secondary)]" data-testid="curl-preview">
                        <div className="font-medium text-[var(--text-primary)]">{t('http_query.curl_preview', 'This will be filled in')}</div>
                        <div><span className="font-mono">{parsed.method}</span> <span className="font-mono break-all">{parsed.url}</span></div>
                        {parsed.query && (
                            <div>
                                {t('http_query.curl_query', 'Parameters')}: <span className="font-mono">
                                    {parsed.query.mode === 'fields' ? (parsed.query.items || []).map((r) => r.key).join(', ') : t('http_query.curl_query_json', 'as JSON')}
                                </span>
                            </div>
                        )}
                        {headerNames.length > 0 && (
                            <div>{t('http_query.curl_headers', 'Headers')}: <span className="font-mono">{headerNames.join(', ')}</span></div>
                        )}
                        {parsed.body && (
                            <pre className="whitespace-pre-wrap break-all font-mono bg-[var(--bg-tertiary)] rounded p-2 max-h-32 overflow-auto">{parsed.body}</pre>
                        )}
                        {parsed.warnings.includes('multipart') && (
                            <div className="text-amber-600">{t('http_query.curl_multipart', 'File and form uploads (-F) are not imported.')}</div>
                        )}
                        {parsed.skipped.length > 0 && (
                            <div role="note" data-testid="curl-secret-notice" className="rounded border border-amber-500/50 bg-amber-500/10 p-2 text-[var(--text-primary)]">
                                {t('http_query.curl_secrets', 'These secrets were not copied: {list}. Create or select a saved credential under Authentication instead.')
                                    .replace('{list}', [...new Set(parsed.skipped.map((s) => s.name))].join(', '))}
                            </div>
                        )}
                    </div>
                )}
                <div className="flex justify-end gap-2 mt-4">
                    <button type="button" onClick={close} className="px-3 py-1.5 text-sm rounded text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]">
                        {t('http_query.curl_cancel', 'Cancel')}
                    </button>
                    <button type="button" disabled={!parsed} onClick={() => { if (parsed) { onApply(parsed); close(); } }}
                        className="px-3 py-1.5 text-sm rounded bg-[var(--accent)] text-white disabled:opacity-50">
                        {t('http_query.curl_apply', 'Fill in step')}
                    </button>
                </div>
            </div>
        </div>
    );
}
