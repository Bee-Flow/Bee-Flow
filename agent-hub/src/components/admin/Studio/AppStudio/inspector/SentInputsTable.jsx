import { AlertTriangle, User } from 'lucide-react';
import React from 'react';
import useTranslation from '../../../../../hooks/useTranslation';

/**
 * "What gets sent" — the run_automation input mapping, read FIRST.
 *
 * The old panel was edit-first: one editor row per parameter, each with a name
 * field, a mode switch and a value field. To answer "what does this button
 * actually send?" — the question an author has ten times for every once they
 * change a mapping — you had to read three form controls per row and hold the
 * result in your head.
 *
 * So this renders the ANSWER as a table and leaves editing to "All options".
 *
 * ── Two rows that were never shown, and both mattered ──────────────────────
 *
 *  • "not used" — a form field bound to nothing. The form collects it, the
 *    person fills it in, and it goes nowhere. Nothing said so, and the failure
 *    looks exactly like a broken routine.
 *
 *  • the signed-in user — every app_trigger run already carries the viewer's
 *    ID (`_viewerUserId`, audited server-side). It is genuinely sent, so it is
 *    listed. What it carries is an ID and NOTHING else: not a name, not an
 *    e-mail address. The row says which, because "the signed-in user is sent"
 *    would let an author believe a name travels with it — and then write a
 *    routine that mails it onward.
 */

/** One row per DECLARED parameter, plus the form fields nothing is using. */
export function buildRows({ paramMetaByName, inputMapping, formFields }) {
    const mapping = inputMapping && typeof inputMapping === 'object' ? inputMapping : {};
    const fields = Array.isArray(formFields) ? formFields : [];

    // A declared contract is authoritative about WHAT the routine wants. With
    // no contract, the mapping itself is all there is to go on.
    const names = paramMetaByName ? Object.keys(paramMetaByName) : Object.keys(mapping);

    const rows = names.map((name) => {
        const bound = mapping[name];
        const meta = paramMetaByName?.[name] || null;
        let source = null;
        if (bound?.kind === 'field') source = { kind: 'field', name: bound.name || '' };
        else if (bound?.kind === 'static') source = { kind: 'static', value: bound.value ?? '' };
        return {
            key: `param:${name}`,
            name,
            type: meta?.type || null,
            required: !!meta?.required,
            source,
            // Declared, required, and bound to nothing: the routine will run
            // with a hole in it. That is a warning, not a fact to render flat.
            missing: !bound,
        };
    });

    // Form inputs that feed no parameter. Only meaningful when we know what
    // the routine declares — without a contract, an unmapped field may well be
    // deliberate, and calling it "not used" would be an accusation we cannot
    // support.
    const used = new Set(Object.values(mapping).filter((m) => m?.kind === 'field').map((m) => m.name));
    const unused = paramMetaByName
        ? fields.filter((f) => f?.name && !used.has(f.name)).map((f) => ({
            key: `unused:${f.name}`, name: f.name, type: f.type || null, unused: true,
        }))
        : [];

    return [...rows, ...unused];
}

function SourceCell({ row, t }) {
    if (row.unused) {
        return (
            <span className="text-[var(--text-muted)]">
                {t('app_studio.inspector.sent_not_used', 'not used')}
            </span>
        );
    }
    if (row.missing) {
        return (
            <span className="inline-flex items-center gap-1 text-amber-600">
                <AlertTriangle className="w-3 h-3 shrink-0" aria-hidden="true" />
                {t('app_studio.inspector.sent_nothing', 'nothing yet')}
            </span>
        );
    }
    if (row.source?.kind === 'field') {
        return row.source.name
            ? <span className="font-mono text-[var(--text-primary)]">{row.source.name}</span>
            : (
                <span className="inline-flex items-center gap-1 text-amber-600">
                    <AlertTriangle className="w-3 h-3 shrink-0" aria-hidden="true" />
                    {t('app_studio.inspector.sent_no_field', 'no field chosen')}
                </span>
            );
    }
    const value = String(row.source?.value ?? '');
    // An empty fixed value is not "a fixed value" — it is nothing, and reading
    // a blank cell as "a value is set" is the mistake this row exists to stop.
    if (!value.trim()) {
        return (
            <span className="inline-flex items-center gap-1 text-amber-600">
                <AlertTriangle className="w-3 h-3 shrink-0" aria-hidden="true" />
                {t('app_studio.inspector.sent_empty_value', 'an empty value')}
            </span>
        );
    }
    return (
        <span className="text-[var(--text-primary)] truncate" title={value}>
            {t('app_studio.inspector.sent_fixed', 'always “{value}”', { value: value.slice(0, 40) })}
        </span>
    );
}

export default function SentInputsTable({ paramMetaByName, inputMapping, formFields, showViewerRow = false }) {
    const { t } = useTranslation();
    const rows = buildRows({ paramMetaByName, inputMapping, formFields });

    if (!rows.length && !showViewerRow) {
        return (
            <p className="text-[11px] text-[var(--text-secondary)]">
                {t('app_studio.inspector.sent_nothing_at_all', 'Nothing is sent with this — the routine runs on what it can find itself.')}
            </p>
        );
    }

    return (
        <table className="w-full text-[11px] border-collapse">
            <caption className="sr-only">
                {t('app_studio.inspector.sent_caption', 'What this button sends to the routine')}
            </caption>
            <thead>
                <tr className="text-left text-[var(--text-tertiary)]">
                    <th scope="col" className="font-medium pb-1 pr-2">
                        {t('app_studio.inspector.sent_col_input', 'Input')}
                    </th>
                    <th scope="col" className="font-medium pb-1">
                        {t('app_studio.inspector.sent_col_source', 'Comes from')}
                    </th>
                </tr>
            </thead>
            <tbody>
                {rows.map((row) => (
                    <tr key={row.key} className="align-top border-t border-[var(--border-subtle)]">
                        <th scope="row" className="font-normal py-1 pr-2 min-w-0">
                            <span className={`font-mono ${row.unused ? 'text-[var(--text-muted)]' : 'text-[var(--text-primary)]'}`}>
                                {row.name}
                            </span>
                            {row.required ? <span className="text-amber-600" aria-hidden="true">*</span> : null}
                            {row.type ? (
                                <span className="ml-1 text-[var(--text-tertiary)]">{row.type}</span>
                            ) : null}
                        </th>
                        <td className="py-1 min-w-0">
                            <SourceCell row={row} t={t} />
                        </td>
                    </tr>
                ))}
                {showViewerRow ? (
                    <tr className="align-top border-t border-[var(--border-subtle)]">
                        <th scope="row" className="font-normal py-1 pr-2">
                            <span className="inline-flex items-center gap-1 text-[var(--text-primary)]">
                                <User className="w-3 h-3 shrink-0" aria-hidden="true" />
                                {t('app_studio.inspector.sent_viewer', 'Signed-in user')}
                            </span>
                        </th>
                        <td className="py-1 text-[var(--text-secondary)]">
                            {/* Says WHAT travels, not just THAT something does.
                                An author who reads "the signed-in user is sent"
                                may write a routine that mails their name. Only
                                the id goes. */}
                            {t('app_studio.inspector.sent_viewer_value', 'their ID only — no name or e-mail address')}
                        </td>
                    </tr>
                ) : null}
            </tbody>
        </table>
    );
}
