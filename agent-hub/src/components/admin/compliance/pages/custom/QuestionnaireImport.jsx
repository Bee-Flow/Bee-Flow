import React, { useMemo, useState } from 'react';
import { ClipboardPaste, Upload } from 'lucide-react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { PRIMARY_ACTION_STYLE } from '../../../../shared/StudioSectionHeader';
import { TONES } from '../../../../shared/statusTone';

/**
 * QuestionnaireImport — paste a customer's NIS2 questionnaire or a sector code
 * and turn it into custom-framework items (CHECK-CATALOGUE §3).
 *
 * Accepts JSON (an array, or `{checks:[…]}`) and delimited text (comma,
 * semicolon or tab — Dutch Excel writes `;`), with or without a header row.
 * Columns: `ref, title, description, severity, evidence_required`.
 *
 * The parser is PURE and exported: the bulk route
 * (`POST /custom/frameworks/:id/checks`) validates again server-side, so this
 * is about showing the customer what will land before it lands — never about
 * being the only gate.
 */

export const SEVERITIES = Object.freeze(['critical', 'high', 'medium', 'low']);
const HEADER_WORDS = /^(ref|reference|nr|no|id|item|title|question|vraag|omschrijving|description|severity|ernst|evidence|bewijs)$/i;
const TRUTHY = /^(1|true|yes|y|ja|x|required|verplicht)$/i;

/** Split one delimited line, honouring "quoted, fields" and doubled quotes. */
export function splitLine(line, delimiter) {
    const out = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (quoted) {
            if (ch === '"') {
                if (line[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
            } else field += ch;
        } else if (ch === '"') {
            quoted = true;
        } else if (ch === delimiter) {
            out.push(field); field = '';
        } else field += ch;
    }
    out.push(field);
    return out.map(s => s.trim());
}

/** The delimiter that yields the most columns on the first non-empty line. */
export function detectDelimiter(lines) {
    const probe = lines.find(l => l.trim()) || '';
    let best = ',';
    let bestCount = 0;
    for (const d of [',', ';', '\t', '|']) {
        const n = splitLine(probe, d).length;
        if (n > bestCount) { best = d; bestCount = n; }
    }
    return best;
}

function normaliseRow(cells) {
    const [ref, title, description, severity, evidence] = cells;
    const sev = String(severity || '').trim().toLowerCase();
    return {
        ref: String(ref || '').trim(),
        title: String(title || '').trim(),
        description: String(description || '').trim() || null,
        severity: SEVERITIES.includes(sev) ? sev : 'medium',
        evidence_required: TRUTHY.test(String(evidence || '').trim()),
    };
}

/**
 * Parse pasted text into bulk-upsert rows.
 * @returns {{ rows: Array<object>, skipped: number, format: 'json'|'delimited'|null, error: string|null }}
 */
export function parseQuestionnaire(text) {
    const raw = typeof text === 'string' ? text.trim() : '';
    if (!raw) return { rows: [], skipped: 0, format: null, error: null };

    if (raw[0] === '[' || raw[0] === '{') {
        let body;
        try { body = JSON.parse(raw); } catch { return { rows: [], skipped: 0, format: 'json', error: 'json_invalid' }; }
        const list = Array.isArray(body) ? body : (Array.isArray(body?.checks) ? body.checks : Array.isArray(body?.rows) ? body.rows : null);
        if (!list) return { rows: [], skipped: 0, format: 'json', error: 'json_shape' };
        const rows = [];
        let skipped = 0;
        for (const r of list) {
            const row = normaliseRow([
                r?.ref ?? r?.reference ?? r?.id,
                r?.title ?? r?.question,
                r?.description,
                r?.severity,
                r?.evidence_required ?? r?.evidenceRequired,
            ]);
            if (row.ref && row.title) rows.push(row); else skipped += 1;
        }
        return { rows, skipped, format: 'json', error: rows.length ? null : 'no_rows' };
    }

    const lines = raw.split(/\r?\n/).filter(l => l.trim());
    const delimiter = detectDelimiter(lines);
    const rows = [];
    let skipped = 0;
    lines.forEach((line, index) => {
        const cells = splitLine(line, delimiter);
        // A first line whose first two cells are column WORDS is a header, not an item.
        if (index === 0 && HEADER_WORDS.test(cells[0] || '') && HEADER_WORDS.test(cells[1] || '')) return;
        const row = normaliseRow(cells);
        if (row.ref && row.title) rows.push(row); else skipped += 1;
    });
    return { rows, skipped, format: 'delimited', error: rows.length ? null : 'no_rows' };
}

const ERROR_COPY = Object.freeze({
    json_invalid: { key: 'compliance.custom_import_err_json', fallback: 'That is not valid JSON.' },
    json_shape: { key: 'compliance.custom_import_err_shape', fallback: 'Expected an array of items, or { "checks": [ … ] }.' },
    no_rows: { key: 'compliance.custom_import_err_empty', fallback: 'No usable rows: every item needs a reference and a title.' },
});

const SECONDARY_BUTTON = 'inline-flex items-center gap-1 px-[9px] py-1 rounded-lg border border-[var(--border-default)] text-[12px] font-medium text-[var(--text-primary)] bg-[var(--bg-card)] disabled:opacity-60';

export default function QuestionnaireImport({ onImport, busy = false, className = '', testId = 'custom-import' }) {
    const { t } = useTranslation();
    const [text, setText] = useState('');
    const [open, setOpen] = useState(false);
    const [failure, setFailure] = useState(null);
    const parsed = useMemo(() => parseQuestionnaire(text), [text]);

    const submit = async () => {
        if (!parsed.rows.length || busy) return;
        setFailure(null);
        try {
            await onImport?.(parsed.rows);
            setText('');
            setOpen(false);
        } catch (e) {
            setFailure(String(e?.message || 'error'));
        }
    };

    if (!open) {
        return (
            <button type="button" className={`${SECONDARY_BUTTON} ${className}`} onClick={() => setOpen(true)} data-testid={`${testId}-open`}>
                <ClipboardPaste size={12} aria-hidden="true" />
                {t('compliance.custom_import_open', 'Paste questionnaire')}
            </button>
        );
    }

    return (
        <section
            className={`rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] px-3.5 py-3 flex flex-col gap-2 text-xs ${className}`}
            style={{ boxShadow: 'var(--shadow-sm)' }}
            data-testid={testId}
        >
            <div className="flex items-center gap-2">
                <ClipboardPaste size={13} className="text-[var(--text-secondary)]" aria-hidden="true" />
                <span className="font-semibold">{t('compliance.custom_import_title', 'Paste questionnaire')}</span>
                <span className="text-[11px] text-[var(--text-tertiary)]">
                    {t('compliance.custom_import_hint', 'one item per line: reference, title, description, severity, evidence required — or JSON')}
                </span>
            </div>
            <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={6}
                className="w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] px-2.5 py-1.5 font-mono text-[11px] leading-4 text-[var(--text-primary)]"
                placeholder={'A.5.1;Information security policy;;high;1\nA.5.2;Roles and responsibilities;;medium;0'}
                data-testid={`${testId}-text`}
            />
            <div className="flex items-center gap-2 flex-wrap">
                {parsed.error && (
                    <span className="text-[11px] font-medium" style={{ color: TONES.error.ink }} data-testid={`${testId}-error`}>
                        {t(ERROR_COPY[parsed.error].key, ERROR_COPY[parsed.error].fallback)}
                    </span>
                )}
                {!parsed.error && parsed.rows.length > 0 && (
                    <span className="text-[11px] text-[var(--text-secondary)]" data-testid={`${testId}-preview`}>
                        {t('compliance.custom_import_preview', '{n} items recognised', { n: parsed.rows.length })}
                        {parsed.skipped > 0 && ` · ${t('compliance.custom_import_skipped', '{n} lines skipped', { n: parsed.skipped })}`}
                    </span>
                )}
                {failure && (
                    <span className="text-[11px] font-medium" style={{ color: TONES.error.ink }} data-testid={`${testId}-failed`}>
                        {t('compliance.custom_import_failed', 'The items could not be saved.')}
                    </span>
                )}
                <button type="button" className={`ml-auto ${SECONDARY_BUTTON}`} onClick={() => { setOpen(false); setText(''); setFailure(null); }}>
                    {t('common.cancel', 'Cancel')}
                </button>
                <button
                    type="button"
                    className="inline-flex items-center gap-1 px-[9px] py-1 rounded-lg text-[12px] font-semibold disabled:opacity-60"
                    style={PRIMARY_ACTION_STYLE}
                    disabled={!parsed.rows.length || busy}
                    onClick={submit}
                    data-testid={`${testId}-submit`}
                >
                    <Upload size={12} aria-hidden="true" />
                    {t('compliance.custom_import_submit', 'Add items')}
                </button>
            </div>
        </section>
    );
}
