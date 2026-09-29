import { ArrowLeft, Loader2, Upload as UploadIcon, Workflow } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { ADD_SOURCE_KINDS, isOfferable, sourceKind } from './sourceKinds';
import useTranslation from '../../../../hooks/useTranslation';
import { kindColorVar } from '../../../shared/kindColors';
import { PRIMARY_ACTION_STYLE } from '../../../shared/StudioSectionHeader';
import Tooltip from '../../../shared/Tooltip';
import useRelativeTime from '../../../../hooks/useRelativeTime';

/** The server's own cap (routes/knowledgeBases/sources.js): 3..500000 chars. */
export const PASTE_MAX_CHARS = 500_000;
/** One file, per the multer config on POST /:id/sources/:sid/files. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

/**
 * "Bron toevoegen" — the seven-button card and the inline form each button
 * opens (Knowledge artboard 1a, right column, `shadow-popover`).
 *
 * ── ALL SEVEN BUTTONS, SIX OF THEM ALIVE ────────────────────────────
 * `text`, `upload` and `webpage` work today; tables (K8), meeting notes (K7)
 * and the automation step (K10) joined them. Only the Nextcloud folder is
 * still ahead, and until it lands its button is DISABLED WITH A TOOLTIP that
 * says so — not hidden, and not live-but-400ing.
 *
 * Hiding them would teach that the product cannot do these things, and the
 * person goes off and builds a CSV export by hand. Leaving them enabled
 * would teach that the product is broken. Greyed with "coming soon" is the
 * only one of the three that is true.
 *
 * ── THE AUTOMATION CARD IS A SIGNPOST, NOT A FORM ───────────────────
 * You do not create an automation source here: one appears when a routine
 * writes to this knowledge base (the `knowledge_write` step). Its card spans
 * both columns and opens an EXPLANATION with a way through to the builder,
 * which is the honest shape of that relationship — and a third state the
 * disabled/enabled pair could not express, since "coming soon" and "fill in
 * this form" would both be lies.
 */
export default function AddSourcePanel({ canManage = false, onCreate, onUpload, busy = false, kbName = '', onNavigate = null, sources = [] }) {
    const { t } = useTranslation();
    const [openKind, setOpenKind] = useState(null);
    const [error, setError] = useState(null);

    const close = () => { setOpenKind(null); setError(null); };

    const submit = async (payload) => {
        setError(null);
        try {
            await onCreate?.(payload);
            close();
        } catch (e) {
            setError(messageFor(t, e));
        }
    };

    return (
        <div
            className="overflow-hidden text-[12px]"
            style={{ borderRadius: 12, background: 'var(--bg-card)', border: '1px solid var(--border-default)', boxShadow: 'var(--shadow-popover)' }}
            data-testid="kb-add-source"
        >
            <div className="px-3.5 py-3 font-semibold" style={{ borderBottom: '1px solid var(--border-default)', color: 'var(--text-primary)' }}>
                {openKind ? (
                    <button
                        type="button"
                        onClick={close}
                        className="inline-flex items-center gap-1.5 focus-visible:outline focus-visible:outline-2 rounded"
                        style={{ outlineColor: 'var(--accent-primary)' }}
                    >
                        <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" />
                        {t(sourceKind(openKind).labelKey, sourceKind(openKind).labelFallback)}
                    </button>
                ) : t('knowledge.add_source', 'Add a source')}
            </div>

            {error && (
                <p className="px-3.5 py-2" role="alert" style={{ color: 'var(--error)' }}>{error}</p>
            )}

            {!openKind ? (
                <div className="p-2.5 grid gap-1.5" style={{ gridTemplateColumns: '1fr 1fr' }}>
                    {ADD_SOURCE_KINDS.map(kind => (
                        <KindButton
                            key={kind}
                            t={t}
                            kind={kind}
                            disabled={!canManage || !isOfferable(kind)}
                            reason={!canManage
                                ? t('knowledge.add_source_no_permission', 'You need "manage knowledge" to add a source.')
                                : t('knowledge.add_source_soon', 'Coming soon — this kind of source is not available yet.')}
                            onClick={() => { setError(null); setOpenKind(kind); }}
                        />
                    ))}
                </div>
            ) : (
                <div className="p-3.5">
                    {openKind === 'text' && <PasteTextForm t={t} busy={busy} onSubmit={submit} />}
                    {openKind === 'webpage' && <WebpageForm t={t} busy={busy} onSubmit={submit} />}
                    {openKind === 'upload' && <UploadFilesForm t={t} busy={busy} onUpload={async (files) => { await onUpload?.(files); close(); }} />}
                    {openKind === 'meeting_tag' && <MeetingTagForm t={t} busy={busy} onSubmit={submit} />}
                    {openKind === 'datatable' && <DatatableForm t={t} busy={busy} onSubmit={submit} />}
                    {openKind === 'automation' && <AutomationSignpost t={t} kbName={kbName} onNavigate={onNavigate} sources={sources} />}
                </div>
            )}
        </div>
    );
}

/**
 * The automation card's panel. An explanation and a door, not a form.
 *
 * Why a whole panel rather than a tooltip: the relationship is genuinely
 * backwards from every other card here, and a person who has just been told
 * "you cannot add this one" needs to know what to do INSTEAD, in the same
 * breath. Two sentences and a link is the shortest thing that does that.
 *
 * The link goes to the routines builder rather than deep-linking a
 * pre-configured step: which routine should write here is the interesting
 * decision, and pre-answering it with a new empty routine would be a guess
 * most of the time — the usual case is a routine that already exists.
 */
export function AutomationSignpost({ t, kbName = '', onNavigate = null, sources = [] }) {
    // The same relative-time hook the Sources list itself uses, so the two
    // never disagree about when a source last ran.
    const rel = useRelativeTime();
    const automationSources = (Array.isArray(sources) ? sources : []).filter(s => s.kind === 'automation');
    return (
        <div className="space-y-2.5" data-testid="kb-signpost-automation">
            <p style={{ color: 'var(--text-secondary)' }}>
                {t('knowledge.automation_signpost.what',
                    'A routine adds itself here. Give any routine the “To knowledge base” step, point that step at {name}, and it appears in this list the moment the routine is saved.',
                    { name: kbName || t('knowledge.automation_signpost.this_base', 'this knowledge base') })}
            </p>
            <p style={{ color: 'var(--text-tertiary)' }}>
                {t('knowledge.automation_signpost.why',
                    'Whatever it writes becomes an answer your agents give, with a citation — so send it finished text, not working notes.')}
            </p>
            {automationSources.length > 0 && (
                /**
                 * The other half of what this card is for: which routines are
                 * ALREADY feeding this base, and when each last did. Without it
                 * the card explains a mechanism while staying silent about the
                 * instances of it sitting in the list right below.
                 */
                <div className="rounded-[10px] overflow-hidden" style={{ border: '1px solid var(--border-default)' }}>
                    {automationSources.map((src, i) => (
                        <div
                            key={src.id}
                            data-testid="kb-signpost-automation-source"
                            className="flex items-center gap-2 px-2.5 py-2"
                            style={i ? { borderTop: '1px solid var(--border-default)' } : undefined}
                        >
                            <Workflow className="w-3.5 h-3.5 shrink-0" style={{ color: kindColorVar('automation') }} aria-hidden="true" />
                            <span className="truncate" style={{ color: 'var(--text-primary)' }}>{src.name}</span>
                            <span className="ml-auto shrink-0" style={{ color: 'var(--text-tertiary)' }}>
                                {t('knowledge.automation_signpost.feeds', 'passes data through')}
                                {' · '}
                                {rel(src.lastRefreshAt)
                                    ? t('knowledge.automation_signpost.last_run', 'last run {when}', { when: rel(src.lastRefreshAt) })
                                    : t('knowledge.automation_signpost.no_run_yet', 'no run yet')}
                            </span>
                        </div>
                    ))}
                </div>
            )}
            <a
                href="/app/studio/automations"
                data-testid="kb-signpost-automation-link"
                onClick={(e) => {
                    // In-SPA when it can be: a raw href full-reloads the app and
                    // loses the reader's place in the studio. The href stays for
                    // middle-click and for "open in new tab".
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0 || !onNavigate) return;
                    e.preventDefault();
                    onNavigate('studio/automations');
                }}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-[8px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1"
                style={{ ...PRIMARY_ACTION_STYLE, outlineColor: 'var(--accent-primary)' }}
            >
                {t('knowledge.automation_signpost.go', 'Open Routines')}
            </a>
        </div>
    );
}

function KindButton({ t, kind, disabled, reason, onClick }) {
    const meta = sourceKind(kind);
    const Icon = meta.icon;
    const wide = kind === 'automation';
    const button = (
        <button
            type="button"
            disabled={disabled}
            onClick={onClick}
            data-testid={`kb-add-kind-${kind}`}
            data-disabled={disabled ? 'true' : 'false'}
            className="w-full flex items-center gap-2 px-2.5 py-2.5 rounded-[10px] text-left disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1"
            style={{ border: '1px solid var(--border-default)', color: 'var(--text-primary)', outlineColor: 'var(--accent-primary)' }}
        >
            <Icon className="w-3.5 h-3.5 shrink-0" style={{ color: meta.tint ? kindColorVar(meta.tint) : 'var(--text-secondary)' }} aria-hidden="true" />
            {t(meta.labelKey, meta.labelFallback)}
            {wide && (
                <span className="ml-auto" style={{ color: 'var(--text-tertiary)' }}>
                    {t('knowledge.kind.automation_hint', 'the “To knowledge base” step')}
                </span>
            )}
        </button>
    );
    return (
        <div style={wide ? { gridColumn: '1 / -1' } : undefined}>
            {disabled ? <Tooltip content={reason}><span className="block">{button}</span></Tooltip> : button}
        </div>
    );
}

/**
 * A table, and which of its columns go in.
 *
 * ── THE COLUMN LIST IS THE WHOLE FORM ───────────────────────────────
 * A row becomes a document of "column: value" lines, and which columns are in
 * it decides whether the document answers anything. A price list needs the
 * name and the price; it does not need `imported_batch_id`, and every column
 * that goes in dilutes the ones that matter for retrieval. So the columns are
 * ticked rather than assumed, defaulting to all of them because that is the
 * answer for a small table and visibly wrong for a wide one.
 *
 * ── AND IT SAYS WHO WILL BE ABLE TO READ THE ROWS ───────────────────
 * A datatable has row-level access rules of its own, and this source reads it
 * as the knowledge base's OWNER. Rows the owner may read become searchable by
 * everyone the knowledge base is shared with — the row rules protect the
 * owner's view of the table, not the reader's. Same trade as a meeting source,
 * and it is said here rather than discovered later.
 */
export function DatatableForm({ t, busy, onSubmit }) {
    const [tables, setTables] = useState(null);      // null = loading
    const [datatableId, setDatatableId] = useState('');
    const [columns, setColumns] = useState([]);
    const [titleColumn, setTitleColumn] = useState('');
    const [loadError, setLoadError] = useState(null);

    useEffect(() => {
        let alive = true;
        import('../Datatables/datatablesApi')
            .then(m => m.datatablesApi.list())
            .then(list => { if (alive) setTables(Array.isArray(list) ? list : (list?.datatables || [])); })
            .catch(e => { if (alive) { setTables([]); setLoadError(e?.message || null); } });
        return () => { alive = false; };
    }, []);

    const table = (tables || []).find(x => x.id === datatableId) || null;
    // The picked table's columns. The LIST never carries them — it is a
    // summary of names and grades — so they are fetched from the schema route
    // when a table is picked; a list row that happens to carry `fields`
    // (older callers, tests) is used as-is. null = loading, [] = none.
    const [fields, setFields] = useState(null);
    const [schemaError, setSchemaError] = useState(null);
    // Only the columns a PERSON declared. Nobody wrote `updated_by`, and
    // nobody wants it read back to them in an answer.
    const keysOf = (list) => (list || [])
        .map(f => f?.key)
        .filter(k => typeof k === 'string' && k && !SYSTEM_COLUMNS.has(k));
    const available = keysOf(fields);

    // A newly-picked table starts with everything ticked: right for a small
    // table, and visibly wrong for a wide one, which is the prompt to narrow it.
    const pickRef = useRef(0);
    const pickTable = (id) => {
        setDatatableId(id);
        setColumns([]);
        setTitleColumn('');
        setSchemaError(null);
        const pick = ++pickRef.current;
        const next = (tables || []).find(x => x.id === id);
        if (!next) { setFields(null); return; }
        const apply = (list) => {
            if (pick !== pickRef.current) return;   // a later pick won
            setFields(Array.isArray(list) ? list : []);
            const keys = keysOf(list);
            setColumns(keys);
            setTitleColumn(keys[0] || '');
        };
        if (Array.isArray(next.fields) && next.fields.length) { apply(next.fields); return; }
        setFields(null);
        import('../Datatables/datatablesApi')
            .then(m => m.datatablesApi.getSchema(id))
            .then(r => apply(r?.fields || []))
            .catch(e => { if (pick === pickRef.current) { setFields([]); setSchemaError(e?.message || 'failed'); } });
    };

    const toggleColumn = (key) => setColumns(prev => (
        prev.includes(key) ? prev.filter(c => c !== key) : [...prev, key]
    ));

    if (tables === null) {
        return (
            <p className="flex items-center gap-2" style={{ color: 'var(--text-tertiary)' }}>
                <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                {t('knowledge.datatable.loading', 'Loading your tables…')}
            </p>
        );
    }

    return (
        <form
            className="flex flex-col gap-2.5"
            data-testid="kb-form-datatable"
            onSubmit={(e) => {
                e.preventDefault();
                onSubmit({
                    kind: 'datatable',
                    config: { datatableId, columns, ...(titleColumn ? { titleColumn } : {}) },
                });
            }}
        >
            <label className="flex flex-col gap-1">
                <span style={{ color: 'var(--text-secondary)' }}>{t('knowledge.datatable.table_label', 'Which table?')}</span>
                <select
                    value={datatableId}
                    onChange={(e) => pickTable(e.target.value)}
                    data-testid="kb-datatable-select"
                    className="px-2.5 py-2 rounded-lg text-xs border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1"
                    style={{ background: 'var(--bg-card)', borderColor: 'var(--border-default)', color: 'var(--text-primary)', outlineColor: 'var(--accent-primary)' }}
                >
                    <option value="">{t('knowledge.datatable.pick', 'Pick a table…')}</option>
                    {tables.map(x => (
                        <option key={x.id} value={x.id}>{x.name}{x.rowCount != null ? ` (${x.rowCount})` : ''}</option>
                    ))}
                </select>
            </label>

            {loadError && (
                <p style={{ color: 'var(--warning-ink, var(--warning))', fontSize: 11 }}>
                    {t('knowledge.datatable.load_failed', 'Could not load your tables.')}
                </p>
            )}

            {table && (
                <fieldset className="flex flex-col gap-1">
                    <legend style={{ color: 'var(--text-secondary)' }}>{t('knowledge.datatable.columns_label', 'Which columns')}</legend>
                    {fields === null && (
                        <p className="flex items-center gap-2 text-[11px] text-[var(--text-tertiary)]" data-testid="kb-datatable-columns-loading">
                            <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
                            {t('knowledge.datatable.columns_loading', 'Reading the table’s columns…')}
                        </p>
                    )}
                    {schemaError && (
                        <p role="alert" className="text-[11px] text-[var(--warning-ink,var(--warning))]">
                            {t('knowledge.datatable.columns_failed', 'Could not read this table’s columns.')}
                        </p>
                    )}
                    <div className="flex flex-wrap gap-1.5">
                        {available.map(key => (
                            <button
                                key={key}
                                type="button"
                                role="switch"
                                aria-checked={columns.includes(key)}
                                onClick={() => toggleColumn(key)}
                                data-testid={`kb-datatable-column-${key}`}
                                data-active={columns.includes(key) ? 'true' : 'false'}
                                className="px-2 py-1 rounded-full text-[11px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1"
                                style={{
                                    border: `1px solid ${columns.includes(key) ? 'var(--text-primary)' : 'var(--border-default)'}`,
                                    color: columns.includes(key) ? 'var(--text-primary)' : 'var(--text-secondary)',
                                    fontWeight: columns.includes(key) ? 600 : 400,
                                    outlineColor: 'var(--accent-primary)',
                                }}
                            >
                                {key}
                            </button>
                        ))}
                    </div>
                    <p style={{ color: 'var(--text-tertiary)', fontSize: 11 }}>
                        {t('knowledge.datatable.columns_hint', 'Every column you include dilutes the ones that answer questions. Leave out what nobody would ask about.')}
                    </p>
                </fieldset>
            )}

            {table && columns.length > 0 && (
                <label className="flex flex-col gap-1">
                    <span style={{ color: 'var(--text-secondary)' }}>{t('knowledge.datatable.title_label', 'Which column names the row')}</span>
                    <select
                        value={titleColumn}
                        onChange={(e) => setTitleColumn(e.target.value)}
                        data-testid="kb-datatable-title"
                        className="px-2.5 py-2 rounded-lg text-xs border"
                        style={{ background: 'var(--bg-card)', borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                    >
                        {columns.map(key => <option key={key} value={key}>{key}</option>)}
                    </select>
                </label>
            )}

            <p style={{ color: 'var(--text-tertiary)', fontSize: 11 }}>
                {t('knowledge.datatable.consequence', 'Rows you can read become searchable for everyone who can see this knowledge base — the table\u2019s own row permissions do not follow them here.')}
            </p>

            <button
                type="submit"
                disabled={busy || !datatableId || columns.length === 0}
                data-testid="kb-datatable-submit"
                className="self-start px-3 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-50 inline-flex items-center gap-1.5"
                style={{ ...PRIMARY_ACTION_STYLE, outlineColor: 'var(--accent-primary)' }}
            >
                {busy && <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />}
                {t('knowledge.datatable.submit', 'Add this table')}
            </button>
        </form>
    );
}

/** Columns the platform maintains — never offered, never quoted at a person. */
const SYSTEM_COLUMNS = new Set(['id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at']);

/**
 * A tag, and which parts of each meeting go in.
 *
 * ── THE CONSEQUENCE IS ON THE FORM, NOT IN A DOC ────────────────────
 * This source moves meeting summaries out of the note's own audience and into
 * the knowledge base's, which may be larger — a colleague who cannot open the
 * note can ask an agent about it. The server holds that line twice (the
 * creator must be able to see the tag; the adapter reads as the KB's owner),
 * but somebody choosing a tag deserves to know what they are choosing BEFORE
 * they press the button, not to be refused after it.
 *
 * ── THE TRANSCRIPT IS NOT AN OPTION ─────────────────────────────────
 * Only the summary, the decisions, the open questions and the actions. A
 * transcript is the raw record of who said what — long, and full of asides
 * nobody meant to publish. It is deliberately not offered rather than offered
 * and discouraged.
 */
export function MeetingTagForm({ t, busy, onSubmit }) {
    const [tag, setTag] = useState('');
    const [fields, setFields] = useState(['summary', 'decisions']);
    const [vocabulary, setVocabulary] = useState([]);

    // The org's own tags, so this is a pick rather than a spelling test.
    // Failing to load them costs the suggestions, never the form: a tag typed
    // by hand is still a tag, and the server checks it either way.
    useEffect(() => {
        let alive = true;
        import('../../../../pages/meeting-notes/lib/transcriptionsApi')
            .then(api => api.listTranscriptionTags())
            .then(list => { if (alive) setVocabulary(Array.isArray(list) ? list : []); })
            .catch(() => {});
        return () => { alive = false; };
    }, []);

    const toggle = (field) => setFields((prev) => {
        // `summary` is not optional — a document of decisions with no context
        // is a list of sentences beginning "we agreed to" about nothing.
        if (field === 'summary') return prev;
        return prev.includes(field) ? prev.filter(f => f !== field) : [...prev, field];
    });

    const FIELD_LABELS = {
        summary: t('knowledge.meeting.field_summary', 'Summary'),
        decisions: t('knowledge.meeting.field_decisions', 'Decisions'),
        questions: t('knowledge.meeting.field_questions', 'Open questions'),
        actions: t('knowledge.meeting.field_actions', 'Actions'),
    };

    return (
        <form
            className="flex flex-col gap-2.5"
            data-testid="kb-form-meeting_tag"
            onSubmit={(e) => { e.preventDefault(); onSubmit({ kind: 'meeting_tag', config: { tag: tag.trim(), fields } }); }}
        >
            <label className="flex flex-col gap-1">
                <span style={{ color: 'var(--text-secondary)' }}>{t('knowledge.meeting.tag_label', 'Which tag?')}</span>
                <input
                    value={tag}
                    onChange={(e) => setTag(e.target.value)}
                    list="kb-meeting-tags"
                    data-testid="kb-meeting-tag"
                    placeholder={t('knowledge.meeting.tag_placeholder', 'e.g. sales')}
                    className="px-2.5 py-2 rounded-lg text-xs border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1"
                    style={{ background: 'var(--bg-card)', borderColor: 'var(--border-default)', color: 'var(--text-primary)', outlineColor: 'var(--accent-primary)' }}
                />
                <datalist id="kb-meeting-tags">
                    {vocabulary.map(v => <option key={v.tag} value={v.tag} />)}
                </datalist>
            </label>

            <fieldset className="flex flex-col gap-1">
                <legend style={{ color: 'var(--text-secondary)' }}>{t('knowledge.meeting.fields_label', 'What goes in')}</legend>
                <div className="flex flex-wrap gap-1.5">
                    {['summary', 'decisions', 'questions', 'actions'].map(field => (
                        <button
                            key={field}
                            type="button"
                            role="switch"
                            aria-checked={fields.includes(field)}
                            disabled={field === 'summary'}
                            onClick={() => toggle(field)}
                            data-testid={`kb-meeting-field-${field}`}
                            data-active={fields.includes(field) ? 'true' : 'false'}
                            className="px-2 py-1 rounded-full text-[11px] disabled:cursor-default focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1"
                            style={{
                                border: `1px solid ${fields.includes(field) ? 'var(--text-primary)' : 'var(--border-default)'}`,
                                color: fields.includes(field) ? 'var(--text-primary)' : 'var(--text-secondary)',
                                fontWeight: fields.includes(field) ? 600 : 400,
                                outlineColor: 'var(--accent-primary)',
                            }}
                        >
                            {FIELD_LABELS[field]}
                        </button>
                    ))}
                </div>
            </fieldset>

            <p style={{ color: 'var(--text-tertiary)', fontSize: 11 }}>
                {t('knowledge.meeting.consequence', 'Everyone who can see this knowledge base will be able to read these summaries — including people who cannot open the meetings themselves. Transcripts never go in.')}
            </p>

            <button
                type="submit"
                disabled={busy || !tag.trim()}
                data-testid="kb-meeting-submit"
                className="self-start px-3 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-50 inline-flex items-center gap-1.5"
                style={{ ...PRIMARY_ACTION_STYLE, outlineColor: 'var(--accent-primary)' }}
            >
                {busy && <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />}
                {t('knowledge.meeting.submit', 'Add meetings')}
            </button>
        </form>
    );
}

/** Naam + tekst. The text goes to the server and never comes back. */
export function PasteTextForm({ t, busy, onSubmit }) {
    const [name, setName] = useState('');
    const [text, setText] = useState('');
    const tooLong = text.length > PASTE_MAX_CHARS;
    const ok = text.trim().length >= 3 && !tooLong;
    return (
        <form
            className="flex flex-col gap-2"
            onSubmit={(e) => { e.preventDefault(); if (ok) onSubmit({ kind: 'text', name: name.trim() || undefined, config: { text } }); }}
        >
            <Field label={t('knowledge.form.name', 'Name')}>
                <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t('knowledge.form.text_name_placeholder', 'e.g. Frequently asked questions')}
                    className={INPUT_CLASS}
                    style={INPUT_STYLE}
                />
            </Field>
            <Field label={t('knowledge.form.text', 'Text')}>
                <textarea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    rows={6}
                    className={INPUT_CLASS}
                    style={INPUT_STYLE}
                />
            </Field>
            {tooLong && (
                <p style={{ color: 'var(--error)' }}>
                    {t('knowledge.form.text_too_long', 'That is longer than {max} characters — split it into a few sources.', { max: PASTE_MAX_CHARS.toLocaleString() })}
                </p>
            )}
            <Submit t={t} busy={busy} disabled={!ok} />
        </form>
    );
}

/** URL + "hele site"-toggle. maxPages is stored; K3 does the crawling. */
export function WebpageForm({ t, busy, onSubmit }) {
    const [url, setUrl] = useState('');
    const [whole, setWhole] = useState(false);
    const [maxPages, setMaxPages] = useState(50);
    const ok = /^https?:\/\/\S+$/i.test(url.trim());
    return (
        <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
                e.preventDefault();
                if (!ok) return;
                onSubmit({
                    kind: 'webpage',
                    config: { url: url.trim(), ...(whole ? { crawl: { maxPages: Number(maxPages) || 50 } } : {}) },
                });
            }}
        >
            <Field label={t('knowledge.form.url', 'Address')}>
                <input
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://example.com/terms"
                    inputMode="url"
                    className={INPUT_CLASS}
                    style={INPUT_STYLE}
                />
            </Field>
            <label className="flex items-center gap-2">
                <input type="checkbox" checked={whole} onChange={(e) => setWhole(e.target.checked)} />
                {t('knowledge.form.whole_site', 'Follow links on the same site')}
            </label>
            {whole && (
                <Field label={t('knowledge.form.max_pages', 'At most this many pages')}>
                    <input
                        type="number"
                        min={1}
                        max={500}
                        value={maxPages}
                        onChange={(e) => setMaxPages(e.target.value)}
                        className={INPUT_CLASS}
                        style={INPUT_STYLE}
                    />
                </Field>
            )}
            <Submit t={t} busy={busy} disabled={!ok} />
        </form>
    );
}

/**
 * Multi-file drop. Files over 20 MB are refused HERE with their own names —
 * a 413 that only says "file_too_large" leaves the person guessing which of
 * eleven files it meant.
 */
export function UploadFilesForm({ t, busy, onUpload }) {
    const inputRef = useRef(null);
    const [rejected, setRejected] = useState([]);

    const pick = async (fileList) => {
        const files = Array.from(fileList || []);
        const tooBig = files.filter(f => f.size > MAX_FILE_BYTES);
        const ok = files.filter(f => f.size <= MAX_FILE_BYTES);
        setRejected(tooBig.map(f => f.name));
        if (ok.length) await onUpload(ok);
    };

    return (
        <div className="flex flex-col gap-2">
            <button
                type="button"
                onClick={() => inputRef.current?.click()}
                disabled={busy}
                className="flex flex-col items-center gap-1.5 py-6 rounded-[10px] disabled:opacity-50"
                style={{ border: '1px dashed var(--border-default)', color: 'var(--text-secondary)' }}
            >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <UploadIcon className="w-4 h-4" aria-hidden="true" />}
                {t('knowledge.form.choose_files', 'Choose files')}
                <span style={{ color: 'var(--text-tertiary)' }}>
                    {t('knowledge.form.file_limit', 'Up to 20 files, 20 MB each')}
                </span>
            </button>
            <input
                ref={inputRef}
                type="file"
                multiple
                className="hidden"
                aria-label={t('knowledge.form.choose_files', 'Choose files')}
                onChange={(e) => { pick(e.target.files); e.target.value = ''; }}
            />
            {rejected.length > 0 && (
                <p style={{ color: 'var(--warning)' }}>
                    {t('knowledge.form.files_too_large', 'Too large, so not uploaded: {names}', { names: rejected.join(', ') })}
                </p>
            )}
        </div>
    );
}

const INPUT_CLASS = 'w-full px-2.5 py-1.5 rounded-lg text-xs border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1';
const INPUT_STYLE = { background: 'var(--bg-card)', borderColor: 'var(--border-default)', color: 'var(--text-primary)', outlineColor: 'var(--accent-primary)' };

function Field({ label, children }) {
    return (
        <label className="flex flex-col gap-1">
            <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
            {children}
        </label>
    );
}

function Submit({ t, busy, disabled }) {
    return (
        <button
            type="submit"
            disabled={disabled || busy}
            className="self-start inline-flex items-center gap-1.5 h-8 px-3 rounded-[10px] text-xs font-semibold disabled:opacity-50"
            style={PRIMARY_ACTION_STYLE}
        >
            {busy && <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />}
            {t('knowledge.form.add', 'Add source')}
        </button>
    );
}

/**
 * The server's error CODE turned into a sentence a person can act on.
 * `source_limit_reached` repeats the number: a cap without its own limit in
 * it tells you that you have too many without telling you how many is too
 * many.
 */
export function messageFor(t, e) {
    switch (e?.code) {
        case 'kind_not_available':
            return t('knowledge.err_kind', 'That kind of source is not available yet.');
        case 'source_limit_reached':
            return t('knowledge.err_source_limit', 'This knowledge base already has the most sources your plan allows ({limit}).', { limit: e?.body?.limit ?? '' });
        case 'url_rejected':
            return t('knowledge.err_url_rejected', 'That address cannot be fetched from here.');
        case 'fetch_failed':
            return t('knowledge.err_fetch_failed', 'That page could not be reached.');
        case 'text_too_long':
            return t('knowledge.err_text_too_long', 'That text is too long — split it into a few sources.');
        default:
            return e?.message || t('knowledge.err_add_source', 'Could not add that source.');
    }
}
