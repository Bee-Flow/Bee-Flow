// The "Query parameters" band of the http_request editor: a switch, rows or a
// JSON text (both accept inserted values), the array format, and a live look
// at the address the run will call.
import { Plus, X } from 'lucide-react';
import { useState, type ComponentType, type ReactNode } from 'react';
import { useTranslation } from '../../../../../../hooks/useTranslation';
import TemplateFieldJs from '../../../mapping/TemplateField';
import AccordionSectionJs from '../../AccordionSection';
import { FormRow, inputClass } from '../formPrimitives';
import {
    ARRAY_FORMATS, mergeMovedQuery, previewUrl, queryPairs, splitQueryFromUrl,
    type ArrayFormat, type HttpQuery,
} from './httpQueryLib';

type AnyProps = Record<string, unknown> & { children?: ReactNode };
const TemplateField = TemplateFieldJs as unknown as ComponentType<AnyProps>;
const AccordionSection = AccordionSectionJs as unknown as ComponentType<AnyProps>;

type Props = {
    draft: { url?: string; query?: HttpQuery | null };
    set: (key: string, value: unknown) => void;
    onFocusField?: unknown;
    previewSample?: unknown;
    errorSections?: Set<string>;
};

const FORMAT_LABEL: Record<ArrayFormat, [string, string]> = {
    indices: ['http_query.format.indices', 'Numbered: a[0]=x&a[1]=y (default)'],
    brackets: ['http_query.format.brackets', 'Brackets: a[]=x&a[]=y'],
    repeat: ['http_query.format.repeat', 'Repeated: a=x&a=y'],
    comma: ['http_query.format.comma', 'Comma separated: a=x,y'],
};

export function HttpQuerySection({ draft, set, onFocusField, previewSample, errorSections = new Set() }: Props) {
    const { t } = useTranslation();
    const [moveNote, setMoveNote] = useState<string | null>(null);
    const query = draft.query && typeof draft.query === 'object' ? draft.query : null;
    const on = !!query;
    const mode = query?.mode === 'json' ? 'json' : 'fields';
    const items = query?.items || [];
    const url = draft.url || '';
    const urlHasQuery = /\?[^#]+/.test(url);
    const { pairs, error } = queryPairs(query);

    const patch = (next: Partial<HttpQuery>) => set('query', { ...(query || { mode: 'fields', items: [] }), ...next });
    const setRow = (i: number, row: Partial<{ key: string; value: string }>) =>
        patch({ items: items.map((r, j) => (j === i ? { ...r, ...row } : r)) });

    const moveFromUrl = () => {
        const split = splitQueryFromUrl(url);
        if (!split) return;
        const merged = mergeMovedQuery(query, split.query);
        if (!merged) {
            setMoveNote(t('http_query.move_blocked', 'The parameters here already hold inserted values, so they cannot be merged automatically. Copy the URL parameters in by hand.'));
            return;
        }
        setMoveNote(null);
        set('query', merged);
        set('url', split.url);
    };

    const errorText = error === 'json'
        ? t('http_query.json_invalid', 'This is not valid JSON yet. Check commas, quotes and brackets.')
        : error === 'not_object'
            ? t('http_query.json_not_object', 'The parameters must be a JSON object, like {"page": 1}.')
            : null;

    return (
        <AccordionSection
            stepType="http_request"
            sectionKey="query"
            title={t('http_query.title', 'Query parameters')}
            defaultOpen={on}
            forceOpen={errorSections.has('query')}
            hasContent={on}
        >
            <label className="flex items-center gap-2 text-sm text-[var(--text-primary)] mb-2">
                <input
                    type="checkbox"
                    checked={on}
                    onChange={(e) => set('query', e.target.checked ? { mode: 'fields', items: [] } : null)}
                />
                {t('http_query.send', 'Send query parameters')}
            </label>

            {on && (
                <>
                    <FormRow label={t('http_query.mode', 'Specify parameters')} hint={null}>
                        <select
                            value={mode}
                            onChange={(e) => {
                                const next = e.target.value as 'fields' | 'json';
                                if (next === mode) return;
                                set('query', next === 'json'
                                    ? { mode: 'json', json: query?.json || '', ...(query?.arrayFormat ? { arrayFormat: query.arrayFormat } : {}) }
                                    : { mode: 'fields', items: query?.items || [], ...(query?.arrayFormat ? { arrayFormat: query.arrayFormat } : {}) });
                            }}
                            className={inputClass()}
                            data-testid="http-query-mode"
                        >
                            <option value="fields">{t('http_query.mode.fields', 'Using fields')}</option>
                            <option value="json">{t('http_query.mode.json', 'Using JSON')}</option>
                        </select>
                    </FormRow>

                    {mode === 'fields' && (
                        <div data-testid="http-query-fields">
                            {items.length === 0 && (
                                <div className="text-xs text-[var(--text-tertiary)] italic mb-2">{t('http_query.none', 'No parameters yet.')}</div>
                            )}
                            {items.map((row, i) => (
                                <div key={i} className="grid grid-cols-[minmax(6rem,32%)_minmax(0,1fr)_auto] items-start gap-2 mb-2" data-testid="http-query-row">
                                    <input
                                        type="text"
                                        value={row.key}
                                        onChange={(e) => setRow(i, { key: e.target.value })}
                                        className={inputClass() + ' min-w-0 font-mono'}
                                        placeholder={t('http_query.key_placeholder', 'name, or list[0][name]')}
                                        aria-label={t('http_query.key', 'Parameter name')}
                                    />
                                    <div className="min-w-0">
                                        <TemplateField
                                            value={row.value}
                                            onChange={(next: string) => setRow(i, { value: next })}
                                            rows={1}
                                            onFocusField={onFocusField}
                                            previewSample={previewSample}
                                            placeholder={t('http_query.value_placeholder', 'value')}
                                            listAs="json"
                                        />
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => patch({ items: items.filter((_, j) => j !== i) })}
                                        title={t('http_query.remove', 'Remove parameter')}
                                        className="p-1.5 rounded text-[var(--text-tertiary)] hover:text-red-500 hover:bg-[var(--bg-tertiary)] transition"
                                    >
                                        <X size={14} />
                                    </button>
                                </div>
                            ))}
                            <button
                                type="button"
                                onClick={() => patch({ items: [...items, { key: '', value: '' }] })}
                                className="flex items-center gap-1 text-xs text-[var(--accent)] hover:opacity-80 transition"
                            >
                                <Plus size={12} /> {t('http_query.add', 'Add parameter')}
                            </button>
                        </div>
                    )}

                    {mode === 'json' && (
                        <FormRow
                            label={t('http_query.json', 'JSON')}
                            hint={t('http_query.json_hint', 'Nested objects and lists are written as a[0][b]=c for you. Click a value in the right panel to insert it, for example {"page": {{trigger.output.page}}}.')}
                        >
                            <div data-testid="http-query-json">
                                <TemplateField
                                    value={query?.json || ''}
                                    onChange={(next: string) => patch({ json: next })}
                                    rows={7}
                                    onFocusField={onFocusField}
                                    previewSample={previewSample}
                                    placeholder={'{"page": 1}'}
                                    listAs="json"
                                />
                            </div>
                            {errorText && <div className="text-xs text-red-500 mt-1" role="alert" data-testid="http-query-json-error">{errorText}</div>}
                        </FormRow>
                    )}

                    <details className="mb-2" data-testid="http-query-advanced">
                        <summary className="text-xs text-[var(--text-tertiary)] cursor-pointer">{t('http_query.advanced', 'Advanced')}</summary>
                        <FormRow label={t('http_query.array_format', 'Lists in the address')} hint={null}>
                            <select
                                value={query?.arrayFormat || 'indices'}
                                onChange={(e) => patch({ arrayFormat: e.target.value as ArrayFormat })}
                                className={inputClass()}
                                data-testid="http-query-array-format"
                            >
                                {ARRAY_FORMATS.map((f) => <option key={f} value={f}>{t(FORMAT_LABEL[f][0], FORMAT_LABEL[f][1])}</option>)}
                            </select>
                        </FormRow>
                    </details>
                </>
            )}

            {on && (
                <div className="mb-2" data-testid="http-query-preview">
                    <div className="text-xs font-medium text-[var(--text-secondary)] mb-1">{t('http_query.preview', "Here's how it looks")}</div>
                    <code className="block text-xs font-mono break-all rounded bg-[var(--bg-tertiary)] text-[var(--text-primary)] p-2" data-testid="http-query-preview-url">
                        {url ? previewUrl(url, query) : t('http_query.preview_no_url', 'Fill in the URL first.')}
                    </code>
                    {pairs.length === 0 && !error && (
                        <div className="text-xs text-[var(--text-tertiary)] mt-1">{t('http_query.preview_empty', 'Nothing is added yet. Empty values are left out.')}</div>
                    )}
                </div>
            )}

            {urlHasQuery && (
                <div className="mt-1">
                    <button
                        type="button"
                        onClick={moveFromUrl}
                        className="text-xs text-[var(--accent)] hover:opacity-80 transition"
                        data-testid="http-query-move"
                    >
                        {t('http_query.move', 'Move query from URL into parameters')}
                    </button>
                    <div className="text-xs text-[var(--text-tertiary)] mt-1">
                        {t('http_query.move_hint', 'Takes everything after the ? out of the URL, so you can insert values into it.')}
                    </div>
                    {moveNote && <div className="text-xs text-red-500 mt-1" role="alert">{moveNote}</div>}
                </div>
            )}
        </AccordionSection>
    );
}
