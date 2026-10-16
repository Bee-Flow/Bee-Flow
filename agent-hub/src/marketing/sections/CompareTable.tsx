import React from 'react';
import SectionHeader from '../components/SectionHeader';
import EditableText from '../components/EditableText';
import SectionFrame from '../components/SectionFrame';
import { sectionBgClass } from './sectionBg';
import { inlineTextStyle } from './textStyle';
import './compareTable.css';
import type { SectionDataBase } from './sectionData.types';

/**
 * Compare table — side-by-side comparison for the comparison pages
 * ("Bee Flow vs X"). Content shape (see BLOCK_DEFAULTS 'compare-table' in
 * server/i18n/defaults/cmsDefaults.js):
 *
 *   { eyebrow, title, lead,
 *     leftLabel: 'Bee Flow', rightLabel: '',
 *     rows: [{ aspect, left, right }],
 *     footnote }
 *
 * Semantics: a real <table> — <th scope="col" role="columnheader"> for the three column heads
 * (aspect corner + leftLabel + rightLabel), <th scope="row" role="rowheader"> for each
 * aspect cell — inside an overflow-x wrapper so narrow viewports scroll
 * the table, never the page. The server-rendered SEO view emits the same
 * rows as a plain <table> (server/core/seo/renderBlocks.js).
 *
 * Published site: rows with no content are dropped, and a block whose rows
 * are ALL empty renders nothing. The editor keeps every row clickable.
 *
 * Inline-edit paths (type-rooted, like every section):
 *   compare-table.eyebrow / .title / .lead
 *   compare-table.leftLabel / .rightLabel
 *   compare-table.rows.{i}.aspect / .left / .right
 *   compare-table.footnote
 */

// True inside the CMS editor's preview iframe (?preview) — empty fields keep
// their clickable placeholder there, but never on the published site.
const isEditable = () =>
    typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).has('preview');

interface CompareRow {
    aspect?: string;
    left?: string;
    right?: string;
}

interface CompareTableData extends SectionDataBase {
    leftLabel?: string;
    rightLabel?: string;
    rows?: CompareRow[];
    footnote?: string;
    footnoteAlign?: string;
}

const hasText = (v: unknown) => typeof v === 'string' && v.trim() !== '';

export default function CompareTable({ data }: { data?: CompareTableData }) {
    if (!data?.enabled) return null;
    const editing = isEditable();

    const rows = Array.isArray(data.rows) ? data.rows : [];
    // Keep the STORED index with each row: the public filter may drop rows,
    // and inline-edit paths must keep pointing at the stored slot.
    const rowEntries = rows
        .map((row, idx) => ({ row: row || {}, idx }))
        .filter(({ row }) => editing
            || hasText(row.aspect) || hasText(row.left) || hasText(row.right));

    // Nothing to compare → the section renders nothing on the published
    // site. The editor still gets the empty table scaffold to type into.
    if (!editing && rowEntries.length === 0) return null;

    // Column names, repeated on each value cell (data-label) for the stacked
    // phone layout in compareTable.css.
    const leftName = data.leftLabel || 'Bee Flow';
    const rightName = data.rightLabel || '';

    const showFootnote = hasText(data.footnote) || editing;

    return (
        <SectionFrame id="compare-table" name="Comparison table" enabled={data.enabled}>
            <section id="compare-table" className={`compare-table-block ${sectionBgClass(data)}`.trim()}>
                <div className="container">
                    <SectionHeader
                        pathPrefix="compare-table"
                        eyebrow={data.eyebrow} title={data.title} lead={data.lead}
                        eyebrowStyle={data.eyebrowStyle} titleStyle={data.titleStyle} leadStyle={data.leadStyle}
                        eyebrowAlign={data.eyebrowAlign} titleAlign={data.titleAlign} leadAlign={data.leadAlign} align={data.align}
                    />
                    <div className="compare-table-scroll reveal">
                        <table className="compare-table" role="table">
                            <thead role="rowgroup">
                                <tr role="row">
                                    {/* Corner cell above the aspect column — an
                                        empty stub head is the conventional
                                        (and screen-reader-safe) treatment. */}
                                    <th scope="col" role="columnheader" />
                                    <th scope="col" role="columnheader" className="compare-table-col--left">
                                        <EditableText path="compare-table.leftLabel" placeholder="Bee Flow">
                                            {data.leftLabel || ''}
                                        </EditableText>
                                    </th>
                                    <th scope="col" role="columnheader">
                                        <EditableText path="compare-table.rightLabel" placeholder="The alternative">
                                            {data.rightLabel || ''}
                                        </EditableText>
                                    </th>
                                </tr>
                            </thead>
                            <tbody role="rowgroup">
                                {rowEntries.map(({ row, idx }) => (
                                    <tr key={idx} role="row">
                                        <th scope="row" role="rowheader">
                                            <EditableText
                                                path={`compare-table.rows.${idx}.aspect`}
                                                multiline
                                                placeholder="Aspect"
                                            >
                                                {row.aspect || ''}
                                            </EditableText>
                                        </th>
                                        <td role="cell" className="compare-table-col--left" data-label={leftName}>
                                            <EditableText
                                                path={`compare-table.rows.${idx}.left`}
                                                multiline
                                                placeholder="How Bee Flow does it"
                                            >
                                                {row.left || ''}
                                            </EditableText>
                                        </td>
                                        <td role="cell" data-label={rightName}>
                                            <EditableText
                                                path={`compare-table.rows.${idx}.right`}
                                                multiline
                                                placeholder="How they do it"
                                            >
                                                {row.right || ''}
                                            </EditableText>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    {showFootnote ? (
                        <EditableText
                            as="p"
                            path="compare-table.footnote"
                            multiline
                            placeholder="Footnote (optional)"
                            className="compare-table-footnote"
                            style={inlineTextStyle(undefined, data.footnoteAlign || data.align)}
                        >
                            {data.footnote || ''}
                        </EditableText>
                    ) : null}
                </div>
            </section>
        </SectionFrame>
    );
}
