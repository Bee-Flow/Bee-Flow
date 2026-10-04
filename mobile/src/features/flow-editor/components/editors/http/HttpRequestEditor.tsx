/**
 * The HTTP request step — the web's HttpRequestFields
 * (actionEditors/httpRequestFields.jsx): the call itself (URL, method,
 * credential, headers, and a body for the methods that send one), its
 * options, and under Advanced the two ticks about not calling twice. The
 * method no longer gates those ticks — many look-up APIs are POST by design —
 * but allowing private targets refuses both.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { BindingInput, NumberField, SelectField, ToggleField } from '@/features/flow-editor/components/fields';
import { readableExample } from '@/features/flow-editor/components/outline/readableText';

import { CacheIntoRow } from './CacheIntoRow';
import { HttpAuth } from './HttpAuth';
import { addHeader, cacheIntoOf, HTTP_METHODS, HTTP_WRITE_METHODS, methodOf, removeHeader, renameHeader, reuseAvailability } from './httpModel';
import { AskOnceRow } from '../declarative/rows/AskOnceRow';
import { say } from '../declarative/runtime';
import { FOR_EACH, retryIsSet, RETRY } from '../declarative/specs/common';
import { AddButton } from '../shared/AddButton';
import { Band } from '../shared/Band';
import { CommitText } from '../shared/CommitText';
import { recordOf } from '../shared/list';
import { Note } from '../shared/Note';
import { RowCard } from '../shared/RowCard';
import { SpecFields } from '../shared/SpecFields';
import type { StepEditorProps } from '../types';

/** The examples in the empty boxes: addresses and JSON, not copy. */
const URL_EXAMPLE = 'https://api.example.com/endpoint';
const HEADER_EXAMPLE = 'Header-Name';
/** Shown as its pill reads: `{"key": "‹Trigger ▸ Value›"}`. */
const BODY_EXAMPLE = '{"key": "{{trigger.output.value}}"}';
/** The hint's example address, with its data as the pill reads. */
const URL_WITH_DATA = 'https://api.example.com/users/{{trigger.output.id}}';

function Headers({ editor }: { editor: StepEditorProps }) {
    const t = useTranslation();
    const { draft, set, ctx } = editor;
    const headers = recordOf(draft.headers);
    const entries = Object.entries(headers);
    return (
        <Band editor={editor} sectionKey="headers" title={t('automations.versions.setting.headers', 'Headers')} hasContent={entries.length > 0}>
            {entries.length === 0 ? <Note>{t('mobile.flow.http.no_headers', 'No headers set.')}</Note> : null}
            {entries.map(([key, value]) => (
                <RowCard key={key} title={key} onRemove={() => set('headers', removeHeader(headers, key))} removeLabel={t('mobile.flow.http.remove_header', 'Remove header')} disabled={ctx.disabled}>
                    <CommitText value={key} onCommit={(next) => set('headers', renameHeader(headers, key, next) ?? headers)} placeholder={HEADER_EXAMPLE} disabled={ctx.disabled} />
                    <BindingInput mode="template" literal="code" value={value} onChange={(v) => set('headers', { ...headers, [key]: v })} disabled={ctx.disabled} />
                </RowCard>
            ))}
            <AddButton label={t('mobile.flow.http.add_header', 'Add header')} onPress={() => set('headers', addHeader(headers))} disabled={ctx.disabled} testID="http-header-add" />
        </Band>
    );
}

function Options({ editor }: { editor: StepEditorProps }) {
    const t = useTranslation();
    const { draft, set, ctx } = editor;
    const parse = typeof draft.parseResponse === 'string' && draft.parseResponse ? draft.parseResponse : 'auto';
    const custom = (draft.timeoutMs != null && draft.timeoutMs !== 10_000) || parse !== 'auto';
    return (
        <Band editor={editor} sectionKey="options" title={t('mobile.flow.section.options', 'Options')} hasContent={custom}>
            <NumberField label={t('mobile.flow.http.timeout', 'Timeout (ms)')} value={draft.timeoutMs ?? 10_000} onChange={(n) => set('timeoutMs', n === '' ? 10_000 : n)} min={1000} max={60_000} integer disabled={ctx.disabled} />
            <SelectField
                label={t('mobile.flow.http.response', 'Response')}
                hint={t('mobile.flow.http.response_hint', 'A JSON answer is also offered parsed, as `data`, so a later step can work through it as a list.')}
                value={parse}
                options={[
                    { value: 'auto', label: t('mobile.flow.http.parse_auto', 'Read JSON automatically') },
                    { value: 'always', label: t('mobile.flow.http.parse_always', 'Always read it as JSON') },
                    { value: 'never', label: t('mobile.flow.http.parse_never', 'Leave it as plain text') },
                ]}
                onChange={(v) => set('parseResponse', v)}
                disabled={ctx.disabled}
            />
            <Note>{t('mobile.flow.http.parse_always_hint', 'Pick “always” when the service sends JSON but labels it as text.')}</Note>
            <ToggleField
                label={t('mobile.flow.http.block_private', 'Block requests to private/internal network addresses')}
                description={t(
                    'mobile.flow.http.block_private_hint',
                    'Recommended: on. Only turn this off if this step specifically needs to reach an internal service (e.g. on your own self-hosted network) — disabling it lets this step reach localhost, private IP ranges, and cloud metadata endpoints.',
                )}
                value={draft.blockPrivateTargets !== false}
                onChange={(on) => set('blockPrivateTargets', on)}
                disabled={ctx.disabled}
                testID="http-block-private"
            />
        </Band>
    );
}

function Advanced({ editor }: { editor: StepEditorProps }) {
    const t = useTranslation();
    const { draft, set, ctx } = editor;
    const reuse = reuseAvailability(draft);
    const busy = !!(draft.forEach || draft.askOnce || draft.cacheInto) || retryIsSet(draft);
    return (
        <Band editor={editor} sectionKey="advanced" title={t('mobile.flow.section.advanced', 'Advanced')} defaultOpen={busy} hasContent={busy}>
            <SpecFields editor={editor} fields={[FOR_EACH, RETRY]} />
            <AskOnceRow
                value={draft.askOnce as never}
                onChange={(next) => set('askOnce', next)}
                blocked={null}
                appLabel={null}
                label={t('mobile.flow.http.ask_once', 'Ask this service only once per run')}
                reason={reuse.askOnce.reason ? say(t, reuse.askOnce.reason) : null}
                disabled={ctx.disabled || reuse.askOnce.disabled}
            />
            <CacheIntoRow
                current={cacheIntoOf(draft)}
                onChange={(next) => set('cacheInto', next)}
                tables={ctx.catalog?.datatables ?? []}
                disabled={ctx.disabled || reuse.cacheInto.disabled}
                reason={reuse.cacheInto.reason ? say(t, reuse.cacheInto.reason) : null}
            />
        </Band>
    );
}

export function HttpRequestEditor(editor: StepEditorProps) {
    const t = useTranslation();
    const { draft, set, ctx } = editor;
    const method = methodOf(draft);
    const connectionId = (draft.auth as { connectionId?: string } | null)?.connectionId ?? '';
    return (
        <>
            <Band editor={editor} sectionKey="request" title={t('mobile.flow.http.request', 'Request')} defaultOpen>
                <BindingInput
                    mode="template"
                    literal="url"
                    required
                    label={t('mobile.flow.http.url', 'URL')}
                    hint={t('mobile.flow.http.url_hint', 'Tap Insert data to put in a value from an earlier step, e.g. {example}.', { example: readableExample(URL_WITH_DATA) })}
                    value={typeof draft.url === 'string' ? draft.url : ''}
                    onChange={(v) => set('url', String(v))}
                    prompt={URL_EXAMPLE}
                    disabled={ctx.disabled}
                    testID="http-url"
                />
                <SelectField
                    required
                    label={t('automations.versions.setting.method', 'Method')}
                    value={method}
                    options={HTTP_METHODS.map((m) => ({ value: m, label: m }))}
                    onChange={(m) => set('method', m)}
                    disabled={ctx.disabled}
                    testID="http-method"
                />
            </Band>
            <Band editor={editor} sectionKey="auth" title={t('mobile.flow.http.authentication', 'Authentication')} defaultOpen={!!connectionId} hasContent={!!connectionId}>
                <HttpAuth value={connectionId} onChange={(id) => set('auth', id ? { connectionId: id } : null)} disabled={ctx.disabled} />
            </Band>
            <Headers editor={editor} />
            {HTTP_WRITE_METHODS.has(method) ? (
                <Band editor={editor} sectionKey="body" title={t('mobile.flow.http.body', 'Body')}>
                    <BindingInput
                        mode="template"
                        literal="code"
                        multiline
                        label={t('mobile.flow.http.body', 'Body')}
                        hint={t('mobile.flow.http.body_hint', 'Raw text or JSON. Tap Insert data to put in a value from an earlier step.')}
                        value={typeof draft.body === 'string' ? draft.body : ''}
                        onChange={(v) => set('body', String(v))}
                        prompt={readableExample(BODY_EXAMPLE)}
                        disabled={ctx.disabled}
                        testID="http-body"
                    />
                </Band>
            ) : null}
            <Options editor={editor} />
            <Advanced editor={editor} />
        </>
    );
}
