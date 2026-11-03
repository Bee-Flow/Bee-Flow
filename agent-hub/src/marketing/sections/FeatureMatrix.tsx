import React, { useState } from 'react';
import { Check, Minus } from 'lucide-react';
import SectionHeader from '../components/SectionHeader';
import EditableText from '../components/EditableText';
import SectionFrame from '../components/SectionFrame';
import { sectionBgClass } from './sectionBg';
import { inlineTextStyle } from './textStyle';
import {
    cellFor, cellMode, columnIds, defaultColumnId, visibleGroups,
} from './featureMatrixModel';
import type { MatrixCell, MatrixColumn, MatrixGroup, MatrixRow, VisibleGroup } from './featureMatrixModel';
import './featureMatrix.css';
import type { SectionDataBase } from './sectionData.types';

/**
 * Feature matrix: a licence/plan table, features as rows, 2-6 plans as
 * columns, rows grouped by category. Content shape (see BLOCK_DEFAULTS
 * 'feature-matrix' in server/i18n/defaults/cmsDefaults.js):
 *
 *   { eyebrow, title, lead,
 *     columns: [{ id, label, highlight }],
 *     groups: [{ id, title, rows: [{ id, label, cells: [{ id: <column id>, kind, text }] }] }],
 *     footnote, includedLabel, excludedLabel, pickerLabel }
 *
 * A cell belongs to a column by `id`, not by position. `kind` is `included`
 * (a check), `excluded` (a dash) or `text` (short text); the two marks carry
 * visually hidden text so a screen reader hears "Included" / "Not included".
 *
 * Wide screens: one <table> with a sticky head row (it follows the page while
 * a long table scrolls). Phones: segmented buttons pick ONE plan, the other
 * columns are hidden (featureMatrix.css), so there is no sideways scroll. All
 * columns stay in the DOM, as they do in the server-rendered HTML
 * (core/seo/renderBlocks.js).
 *
 * Published site: rows with no content and groups left empty are dropped, and
 * a matrix with nothing to show renders nothing. The editor keeps every slot.
 *
 * Inline-edit paths (type-rooted, like every section):
 *   feature-matrix.eyebrow / .title / .lead / .footnote
 *   feature-matrix.columns.{i}.label
 *   feature-matrix.groups.{g}.title
 *   feature-matrix.groups.{g}.rows.{r}.label
 *   feature-matrix.groups.{g}.rows.{r}.cells.{c}.text
 */

// True inside the CMS editor's preview iframe (?preview) — empty fields keep
// their clickable placeholder there, but never on the published site.
const isEditable = () =>
    typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).has('preview');

interface FeatureMatrixData extends SectionDataBase {
    columns?: MatrixColumn[];
    groups?: MatrixGroup[];
    footnote?: string;
    footnoteAlign?: string;
    includedLabel?: string;
    excludedLabel?: string;
    pickerLabel?: string;
}

const P = 'feature-matrix';

interface MarkLabels { included: string; excluded: string }

function ValueCell({ cell, path, labels }: { cell: MatrixCell | undefined; path: string | null; labels: MarkLabels }) {
    const mode = cellMode(cell);
    if (mode === 'included' || mode === 'excluded') {
        const Icon = mode === 'included' ? Check : Minus;
        return (
            <span className={`fm-mark fm-mark--${mode}`}>
                <Icon className="fm-mark-icon" aria-hidden="true" />
                <span className="fm-sr">{labels[mode]}</span>
            </span>
        );
    }
    if (path === null) return null;
    return (
        <EditableText path={`${path}.text`} multiline placeholder="Value">
            {cell?.text || ''}
        </EditableText>
    );
}

interface ColumnInfo { column: MatrixColumn; index: number; id: string; selected: boolean }

const colClass = (base: string, c: ColumnInfo) =>
    `${base}${c.column.highlight === true ? ` ${base}--highlight` : ''}${c.selected ? ` ${base}--selected` : ''}`;

function MatrixRowView({ row, path, columns, labels }: { row: MatrixRow; path: string; columns: ColumnInfo[]; labels: MarkLabels }) {
    return (
        <tr>
            <th scope="row">
                <EditableText path={`${path}.label`} multiline placeholder="Feature">
                    {row.label || ''}
                </EditableText>
            </th>
            {columns.map((c) => {
                const found = cellFor(row, c.id);
                return (
                    <td key={c.id || c.index} className={colClass('fm-cell', c)}>
                        <ValueCell
                            cell={found?.cell}
                            path={found ? `${path}.cells.${found.index}` : null}
                            labels={labels}
                        />
                    </td>
                );
            })}
        </tr>
    );
}

function Picker({ columns, label, onPick }: { columns: ColumnInfo[]; label: string; onPick: (id: string) => void }) {
    return (
        <div className="fm-picker reveal" role="group" aria-label={label}>
            {columns.map((c) => (
                <button
                    key={c.id || c.index}
                    type="button"
                    className={colClass('fm-picker-btn', c)}
                    aria-pressed={c.selected}
                    onClick={() => onPick(c.id)}
                >
                    {c.column.label || ''}
                </button>
            ))}
        </div>
    );
}

/** The columns to draw, each with its STORED index and whether the phone shows it. */
function resolveColumns(stored: MatrixColumn[], picked: string | null, editing: boolean): ColumnInfo[] {
    const current = picked && columnIds(stored).includes(picked) ? picked : defaultColumnId(stored);
    return stored
        .map((column, index) => ({ column, index, id: column.id || '', selected: !!column.id && column.id === current }))
        .filter((c) => editing || c.id !== '');
}

function MatrixTable({ columns, groups, labels, editing }: {
    columns: ColumnInfo[]; groups: VisibleGroup[]; labels: MarkLabels; editing: boolean;
}) {
    return (
        <div className="fm-wrap reveal">
            <table className="fm-table">
                <thead>
                    <tr>
                        <th scope="col" className="fm-corner" />
                        {columns.map((c) => (
                            <th key={c.id || c.index} scope="col" className={colClass('fm-col', c)}>
                                <EditableText path={`${P}.columns.${c.index}.label`} placeholder="Plan">
                                    {c.column.label || ''}
                                </EditableText>
                            </th>
                        ))}
                    </tr>
                </thead>
                {groups.map(({ group, index: g, rows }) => (
                    <tbody key={group.id || g}>
                        {editing || (group.title || '').trim() !== '' ? (
                            <tr className="fm-group">
                                <th scope="colgroup" colSpan={columns.length + 1}>
                                    <EditableText path={`${P}.groups.${g}.title`} placeholder="Group name">
                                        {group.title || ''}
                                    </EditableText>
                                </th>
                            </tr>
                        ) : null}
                        {rows.map(({ row, index: r }) => (
                            <MatrixRowView
                                key={row.id || r}
                                row={row}
                                path={`${P}.groups.${g}.rows.${r}`}
                                columns={columns}
                                labels={labels}
                            />
                        ))}
                    </tbody>
                ))}
            </table>
        </div>
    );
}

export default function FeatureMatrix({ data }: { data?: FeatureMatrixData }) {
    const [picked, setPicked] = useState<string | null>(null);
    if (!data?.enabled) return null;
    const editing = isEditable();

    // Keep the STORED index with each column: inline-edit paths must keep
    // pointing at the stored slot.
    const stored = (Array.isArray(data.columns) ? data.columns : []).map((c) => c || {});
    const columns = resolveColumns(stored, picked, editing);
    const groups = visibleGroups(data.groups, editing);

    // Nothing to compare: nothing on the published site; the editor gets the scaffold.
    if (!editing && (columns.length === 0 || groups.length === 0)) return null;

    const labels: MarkLabels = {
        included: data.includedLabel || 'Included',
        excluded: data.excludedLabel || 'Not included',
    };
    const showFootnote = (typeof data.footnote === 'string' && data.footnote.trim() !== '') || editing;

    return (
        <SectionFrame id={P} name="Feature matrix" enabled={data.enabled}>
            <section id={P} className={`feature-matrix-block ${sectionBgClass(data)}`.trim()}>
                <div className="container">
                    <SectionHeader
                        pathPrefix={P}
                        eyebrow={data.eyebrow} title={data.title} lead={data.lead}
                        eyebrowStyle={data.eyebrowStyle} titleStyle={data.titleStyle} leadStyle={data.leadStyle}
                        eyebrowAlign={data.eyebrowAlign} titleAlign={data.titleAlign} leadAlign={data.leadAlign} align={data.align}
                    />
                    <Picker columns={columns} label={data.pickerLabel || 'Choose a plan'} onPick={setPicked} />
                    <MatrixTable columns={columns} groups={groups} labels={labels} editing={editing} />
                    {showFootnote ? (
                        <EditableText
                            as="p"
                            path={`${P}.footnote`}
                            multiline
                            placeholder="Footnote (optional)"
                            className="fm-footnote"
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
