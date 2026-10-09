// The http_request editor: the call itself (URL, method, credential, headers,
// body), its options, and the two Advanced ticks about not calling twice.
import { Plus, X } from 'lucide-react';
import { useTranslation } from '../../../../../../hooks/useTranslation';
import TemplateField from '../../../mapping/TemplateField';
import AccordionSection from '../../AccordionSection';
import { ForEachSection, RetrySection, retryIsSet } from '../collectionEditors';
import { FormRow, inputClass } from '../formPrimitives';
import HttpAuthPicker from '../HttpAuthPicker';
import { AskOnceRow } from './askOnceRow';
import { CacheIntoRow } from './cacheIntoRow';
import { useState } from 'react';
import { CurlImportDialog } from './CurlImportDialog';
import { mergeMovedQuery } from './httpQueryLib';
import { HttpQuerySection } from './httpQuerySection';

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];
const HTTP_WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function HttpRequestFields({ draft, set, groups = [], onFocusField, previewSample, errorSections = new Set(), catalog = null }) {
    const { t } = useTranslation();
    const [curlOpen, setCurlOpen] = useState(false);
    const method = (draft.method || 'GET').toUpperCase();
    const headers = draft.headers || {};
    const headerEntries = Object.entries(headers);
    const blockPrivateTargets = draft.blockPrivateTargets !== false;
    // The METHOD no longer gates either tick. Many look-up APIs are POST by
    // design (DataForSEO, GraphQL, Elasticsearch) because the query does not fit
    // in a URL, and refusing those refused the very calls a cache is for.
    //
    // What stays a REFUSAL is the SSRF toggle: with private targets allowed a
    // cache hit would launder an answer past a control a reviewer later switches
    // back on, because no fetch happens on a hit. That one is disabled rather
    // than merely ignored — a step that silently never reuses anything looks
    // exactly like a slow step.
    //
    // For a write method the tick is ENABLED and carries a caution instead. The
    // author is the only one who knows whether their POST searches or creates;
    // the validator warns on the same condition, and neither blocks.
    const writeCaution = HTTP_WRITE_METHODS.has(method)
        ? `A ${method} is not promised to be a look-up — if this call creates or changes something, reusing the answer skips it.`
        : null;
    const askOnce = !blockPrivateTargets
        ? { disabled: true, disabledReason: 'Not while private targets are allowed.' }
        : { disabled: false, disabledReason: writeCaution };
    // The SAME refusal, worded for the other tick. Not the same sentence: two
    // controls whose reasons read identically leave the author unable to tell
    // which one is being explained.
    const cacheInto = !blockPrivateTargets
        ? { disabled: true, disabledReason: 'Nothing is kept while private targets are allowed.' }
        : { disabled: false, disabledReason: writeCaution };

    // Secrets were already left out by the parser; headers merge over the existing ones.
    const applyCurl = (p) => {
        set('method', p.method);
        set('url', p.url);
        if (p.query) {
            const q = draft.query;
            const hasExisting = !!q && ((q.mode === 'json' && (q.json || '').trim()) || (q.items || []).some((r) => r.key.trim()));
            const asJson = p.query.mode === 'json' ? p.query : { mode: 'json', json: JSON.stringify(Object.fromEntries((p.query.items || []).map((r) => [r.key, r.value]))), arrayFormat: 'indices' };
            set('query', hasExisting ? (mergeMovedQuery(q, asJson) || p.query) : p.query);
        }
        if (Object.keys(p.headers).length) set('headers', { ...headers, ...p.headers });
        if (p.body) set('body', p.body);
    };

    const renameHeader = (oldKey, newKey) => {
        if (!newKey || newKey === oldKey) return;
        const next = {};
        for (const [k, v] of headerEntries) next[k === oldKey ? newKey : k] = v;
        set('headers', next);
    };
    const setHeaderValue = (key, value) => set('headers', { ...headers, [key]: value });
    const removeHeader = (key) => {
        const next = { ...headers };
        delete next[key];
        set('headers', next);
    };
    const addHeader = () => {
        let name = 'Header';
        let i = 1;
        while (Object.prototype.hasOwnProperty.call(headers, name)) name = `Header-${i++}`;
        set('headers', { ...headers, [name]: '' });
    };

    return (
        <>
            <AccordionSection stepType="http_request" sectionKey="request" title="Request" defaultOpen forceOpen={errorSections.has('request')}>
                <FormRow label="URL" required hint="Click a value in the right panel to insert it, e.g. https://api.example.com/users/{{trigger.output.id}}.">
                    <TemplateField
                        value={draft.url || ''}
                        onChange={(next) => set('url', next)}
                        rows={1}
                        onFocusField={onFocusField}
                        previewSample={previewSample}
                        placeholder="https://api.example.com/endpoint"
                        listAs="json"
                    />
                </FormRow>
                <button type="button" onClick={() => setCurlOpen(true)} className="text-xs text-[var(--accent)] hover:opacity-80 transition mb-2">
                    {t('http_query.curl_button', 'Import cURL')}
                </button>
                <CurlImportDialog open={curlOpen} onClose={() => setCurlOpen(false)} onApply={applyCurl} />
                <FormRow label="Method" required>
                    <select value={method} onChange={(e) => set('method', e.target.value)} className={inputClass()}>
                        {HTTP_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
                    </select>
                </FormRow>
            </AccordionSection>

            <HttpQuerySection draft={draft} set={set} onFocusField={onFocusField} previewSample={previewSample} errorSections={errorSections} />

            <AccordionSection
                stepType="http_request"
                sectionKey="auth"
                title="Authentication"
                defaultOpen={!!(draft.auth && draft.auth.connectionId)}
                forceOpen={errorSections.has('auth')}
            >
                <FormRow label="Credential">
                    <HttpAuthPicker
                        value={draft.auth?.connectionId || ''}
                        onChange={(connectionId) => set('auth', connectionId ? { connectionId } : null)}
                    />
                </FormRow>
            </AccordionSection>

            <AccordionSection stepType="http_request" sectionKey="headers" title="Headers" forceOpen={errorSections.has('headers')} hasContent={headerEntries.length > 0}>
                {headerEntries.length === 0 && (
                    <div className="text-xs text-[var(--text-tertiary)] italic mb-2">No headers set.</div>
                )}
                {headerEntries.map(([key, value]) => (
                    // Two columns that share the row: the name a bounded
                    // third, the value (pills and all) the rest. As a flex row
                    // the name input's own `w-full` won over its width and the
                    // value field was squeezed off the edge.
                    <div key={key} className="grid grid-cols-[minmax(6rem,32%)_minmax(0,1fr)_auto] items-start gap-2 mb-2" data-testid="http-header-row">
                        <input
                            type="text"
                            defaultValue={key}
                            onBlur={(e) => renameHeader(key, e.target.value)}
                            className={inputClass() + ' min-w-0 font-mono'}
                            placeholder="Header-Name"
                        />
                        <div className="min-w-0" data-testid="http-header-value">
                            <TemplateField
                                value={value}
                                onChange={(next) => setHeaderValue(key, next)}
                                rows={1}
                                onFocusField={onFocusField}
                                previewSample={previewSample}
                                placeholder="value"
                                listAs="json"
                            />
                        </div>
                        <button
                            type="button"
                            onClick={() => removeHeader(key)}
                            title="Remove header"
                            className="p-1.5 rounded text-[var(--text-tertiary)] hover:text-red-500 hover:bg-[var(--bg-tertiary)] transition"
                        >
                            <X size={14} />
                        </button>
                    </div>
                ))}
                <button
                    type="button"
                    onClick={addHeader}
                    className="flex items-center gap-1 text-xs text-[var(--accent)] hover:opacity-80 transition"
                >
                    <Plus size={12} /> Add header
                </button>
            </AccordionSection>

            {HTTP_WRITE_METHODS.has(method) && (
                <AccordionSection stepType="http_request" sectionKey="body" title="Body" forceOpen={errorSections.has('body')}>
                    <FormRow label="Body" hint="Raw text or JSON. Click a value in the right panel to insert it.">
                        <TemplateField
                            value={draft.body || ''}
                            onChange={(next) => set('body', next)}
                            rows={6}
                            onFocusField={onFocusField}
                            previewSample={previewSample}
                            placeholder={'{"key": "{{trigger.output.value}}"}'}
                            listAs="json"
                        />
                    </FormRow>
                </AccordionSection>
            )}

            <AccordionSection stepType="http_request" sectionKey="options" title="Options" forceOpen={errorSections.has('options')} hasContent={(draft.timeoutMs != null && draft.timeoutMs !== 10_000) || (draft.parseResponse && draft.parseResponse !== 'auto')}>
                <FormRow label="Timeout (ms)">
                    <input
                        type="number"
                        min={1000}
                        max={60_000}
                        step={500}
                        value={draft.timeoutMs ?? 10_000}
                        onChange={(e) => set('timeoutMs', Number(e.target.value))}
                        className={inputClass()}
                    />
                </FormRow>
                {/* `body` is always the raw text. `data` is the same thing
                    parsed, and it is what a later step binds a LIST to — so
                    this control decides whether the response is usable as a
                    table at all. */}
                <FormRow
                    label="Response"
                    hint="A JSON answer is also offered parsed, as `data`, so a later step can work through it as a list."
                >
                    <select
                        value={draft.parseResponse || 'auto'}
                        onChange={(e) => set('parseResponse', e.target.value)}
                        className={inputClass()}
                    >
                        <option value="auto">Read JSON automatically</option>
                        <option value="always">Always read it as JSON</option>
                        <option value="never">Leave it as plain text</option>
                    </select>
                    <div className="text-xs text-[var(--text-tertiary)] mt-1">
                        Pick “always” when the service sends JSON but labels it as text.
                    </div>
                </FormRow>
                <FormRow label="Security">
                    <label className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
                        <input
                            type="checkbox"
                            checked={blockPrivateTargets}
                            onChange={(e) => set('blockPrivateTargets', e.target.checked)}
                        />
                        Block requests to private/internal network addresses
                    </label>
                    <div className="text-xs text-[var(--text-tertiary)] mt-1">
                        Recommended: on. Only turn this off if this step specifically needs to reach an
                        internal service (e.g. on your own self-hosted network) — disabling it lets this
                        step reach localhost, private IP ranges, and cloud metadata endpoints.
                    </div>
                </FormRow>
            </AccordionSection>

            <AccordionSection
                stepType="http_request" sectionKey="advanced" title="Advanced"
                defaultOpen={!!(draft.forEach || draft.askOnce || draft.cacheInto) || retryIsSet(draft)}
                forceOpen={errorSections.has('advanced')}
                hasContent={!!(draft.forEach || draft.askOnce || draft.cacheInto) || retryIsSet(draft)}
            >
                <ForEachSection draft={draft} set={set} groups={groups} onFocusField={onFocusField} />
                <RetrySection draft={draft} set={set} />
                <AskOnceRow
                    draft={draft} set={set}
                    label="Ask this service only once per run"
                    disabled={askOnce.disabled}
                    disabledReason={askOnce.disabledReason}
                />
                <CacheIntoRow
                    draft={draft} set={set} catalog={catalog}
                    disabled={cacheInto.disabled}
                    disabledReason={cacheInto.disabledReason}
                />
            </AccordionSection>
        </>
    );
}

export { HttpRequestFields };
