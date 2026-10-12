/**
 * CitationChips — the knowledge-base passages behind an answer, as small
 * clickable pills. Clicking one opens `CitationOverlay` through the page's
 * `onCitationClick`.
 *
 * ── ONE CHIP ROW, EVERY SURFACE ─────────────────────────────────────
 * Notebook chat, agent chat and the Knowledge Studio's test question all show
 * the same thing, off the same `kb_sources` event, in the shape
 * `core/kb/citation.js` builds. So this renders that shape rather than each
 * surface growing its own row.
 *
 * ── THE PAGE NUMBER IS THE POINT, AND IT IS OFTEN ABSENT ────────────
 * "Personeelshandboek" is not a citation. "Personeelshandboek · p. 12" is:
 * it can be checked. But `page` only exists for documents ingested after the
 * chunker learned to stamp one, and the bytes of everything before that are
 * gone — so a chip WITHOUT a page is the normal, permanent state for a large
 * part of any install, not a loading state. It renders as a chip that simply
 * says less, never as a gap or a "p. ?".
 *
 * ── A PAGE IS NOT THE ONLY UNIT ─────────────────────────────────────
 * A page number answers "which part of this" for a PDF and for nothing else.
 * A table passage is a block of rows and a meeting note is a day, and both
 * used to cite as a bare title — the very chip a page number exists to
 * prevent. So a range of rows and a date are read the same way the page is:
 * shown when the retrieval layer knew one, silently absent otherwise, and
 * never guessed at. A citation carrying none of the three is not a degraded
 * chip; it is the normal one, and it renders exactly as it always has.
 *
 * ── A LIVE TABLE ROW IS ITS OWN SORT ────────────────────────────────
 * `kind: 'datatable_row'` is a row read straight out of a table AT QUESTION
 * TIME — no document, no chunk, no ingest, so no page and no row range either.
 * All it carries is its own label and the table it came from, and without the
 * table name ("Widget A") it is the bare, uncheckable chip a page number
 * exists to prevent. So the table takes the page's place, and the Table glyph
 * says at a glance that this is a row and not a page of a PDF.
 *
 * The kind icon comes from the same `kindColors` map the rest of Studio uses,
 * so a webpage passage and a meeting passage are told apart at a glance
 * instead of all being a document glyph.
 */
import { FileText } from 'lucide-react';
import React from 'react';
import { passageCountOf, passagesNote, whenLabel } from './citationText';
import { kindColorVar, kindIcon } from '../../../components/shared/kindColors';

/** `kind` on a citation is a retrieval kind; map the ones with a Studio glyph. */
const KIND_ALIAS = Object.freeze({
    kb_chunk: 'kb',
    url_import: 'webpage',
    webpage: 'webpage',
    notebook: 'notebook',
    meeting: 'meeting',
    datatable: 'datatable',
    // A LIVE table row (`core/tools/datatableTools.js`), read at question time.
    // It used to fall through to the generic document glyph, so "Widget A"
    // looked like a page of a PDF — the one thing it is not.
    datatable_row: 'datatable',
});

/** A whole number above zero, or null — the only ordinal worth printing. */
function ordinal(value) {
    return Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * The table rows a passage covers: "rows 1–50", or "row 7" when it is one row.
 *
 * BOTH ends or nothing. "rows 12–" reads as a bug, and printing one end as if
 * it were the whole range says something false about where to look.
 */
function rowsLabel(source, tt) {
    const from = ordinal(source?.rowStart);
    const to = ordinal(source?.rowEnd);
    if (from === null || to === null || to < from) return null;
    return from === to
        ? tt('notebooks.row_short', 'row {n}', { n: from })
        : tt('notebooks.rows_short', 'rows {from}–{to}', { from, to });
}

/**
 * De TABEL waar een live rij uit komt.
 *
 * Een rij die op het moment van de vraag uit de tabel is gelezen heeft geen
 * pagina, geen rijbereik en geen datum — alleen zijn eigen label ("Widget A").
 * Dat is precies de kale chip waar het paginanummer voor bestaat. De tabelnaam
 * maakt hem opzoekbaar: "Widget A · Producten".
 *
 * Alleen bij een ECHTE live rij, en dat is het paar `datatableId`+`rowId` —
 * `core/kb/citation.js` zet die twee samen of geen van beide. Op de naam
 * afgaan zou de bronnaam van elke gewone kb-passage ("Nextcloud · /Sales")
 * achter elke chip in het product plakken.
 */
function tableLabel(source) {
    if (!source?.datatableId || !source?.rowId) return null;
    const name = typeof source?.sourceName === 'string' ? source.sourceName.trim() : '';
    return name || null;
}

/**
 * A chip label in two halves: the TITLE, which may be truncated, and what
 * places it (rows, table, page, date), which must stay readable. That second
 * half is what tells two similar documents apart, and a single truncated
 * string used to cut it off first (BFSF-352).
 */
function chipParts(source, index, tt) {
    const title = source?.title || `${tt('notebooks.source', 'Source')} ${index + 1}`;
    // A chip that folds several passages of one document stands for the
    // document; a page or a row range belongs to one passage, so it is left out.
    const folded = passageCountOf(source) > 0;
    // A positive integer only: `p. 0` says the chunker guessed.
    const page = folded ? null : ordinal(source?.page);
    // Rows before the page: a table passage has no page, and if it somehow
    // carries one, the rows are what a person can actually go and check.
    const where = (folded ? null : rowsLabel(source, tt))
        || tableLabel(source)
        || (page ? tt('notebooks.page_short', 'p. {n}', { n: page }) : null);
    const meta = [where, whenLabel(source)].filter(Boolean).join(' · ');
    return { title, meta };
}

export function chipLabel(source, index, tt) {
    const { title, meta } = chipParts(source, index, tt);
    return meta ? `${title} · ${meta}` : title;
}

/**
 * The visible text of a chip. Only the title truncates; the place and the
 * date after it stay whole, and a chip that folds several passages of one
 * document says how many.
 */
export function ChipText({ source, index, tt }) {
    const { title, meta } = chipParts(source, index, tt);
    const count = passageCountOf(source);
    return (
        <>
            <span className="inline-flex items-center min-w-0">
                <span className="truncate max-w-[170px]">{title}</span>
                {meta && <span className="shrink-0 whitespace-pre">{` · ${meta}`}</span>}
            </span>
            {count > 0 && (
                <span className="shrink-0 opacity-70" data-testid="citation-chip-count">
                    {tt('chat.citation_passage_count', '×{count}', { count })}
                </span>
            )}
        </>
    );
}

/**
 * De tooltip: het label, plus de kop waar de passage onder staat.
 *
 * Alleen als die kop nog iets TOEVOEGT. Bij een tabelrij is de "kop" de naam
 * van de tabel, en die staat al in het label — "Widget A · Producten —
 * Producten" leest als een fout in het product.
 */
export function chipTitle(source, label) {
    const section = typeof source?.section === 'string' ? source.section.trim() : '';
    if (!section || label.includes(section)) return label;
    return `${label} — ${section}`;
}

/**
 * `t` with a fallback that still INTERPOLATES.
 *
 * The old form returned the raw fallback whenever no translator was passed,
 * so a chip on a surface that does not thread one through rendered the
 * literal `p. {n}` — a placeholder shown to a person, which reads as a bug in
 * the product rather than a missing translation.
 */
function translator(t) {
    return (key, fallback, params) => {
        const translated = t ? t(key, fallback, params) : null;
        if (translated != null) return translated;
        if (!params) return fallback;
        return String(fallback).replace(/\{(\w+)\}/g, (_, name) => (
            Object.prototype.hasOwnProperty.call(params, name) ? params[name] : `{${name}}`
        ));
    };
}

export default function CitationChips({ sources, onCitationClick, t }) {
    if (!sources?.length) return null;
    const tt = translator(t);
    return (
        <div className="flex flex-wrap gap-1.5 mt-1.5" role="list" aria-label={tt('notebooks.sources', 'Sources')}>
            {sources.map((s, i) => {
                const label = chipLabel(s, i, tt);
                const passages = passagesNote(s, tt);
                const kind = KIND_ALIAS[s?.kind] || null;
                const Glyph = (kind && kindIcon(kind)) || FileText;
                const colour = kind ? kindColorVar(kind) : 'var(--accent-primary)';
                return (
                    <button
                        key={s?.chunkId ?? s?.documentId ?? i}
                        role="listitem"
                        data-testid="citation-chip"
                        onClick={() => onCitationClick?.({ ...s, index: i + 1 })}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-medium transition-colors hover:bg-[var(--accent-primary)]/10"
                        style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)', background: 'var(--bg-tertiary)' }}
                        title={passages ? `${chipTitle(s, label)} (${passages})` : chipTitle(s, label)}
                        aria-label={passages ? `${label}, ${passages}` : label}
                    >
                        <Glyph className="w-2.5 h-2.5 shrink-0" strokeWidth={2} style={{ color: colour }} />
                        <ChipText source={s} index={i} tt={tt} />
                    </button>
                );
            })}
        </div>
    );
}
