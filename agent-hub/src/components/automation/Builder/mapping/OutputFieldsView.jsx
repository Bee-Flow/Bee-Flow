import React from 'react';
import { sampleToFields } from './upstream';
import { useTranslation } from '../../../../hooks/useTranslation';
import SourceNode from '../sources/SourceNode';

/**
 * A step's output as a FIELD LIST — the "Continues on" column of design 1h:
 *
 *   Forecast      list of 3 · number     2027 · 2028 · 2029
 *   Growth        text                   "4.3% per year"
 *   Explanation   text · 2 paragraphs    "The model is consistent…"
 *
 * The same row the Incoming column uses (sources/SourceNode), so what a
 * step PRODUCES reads exactly like what the next step will see it as. The
 * table and JSON views stay one click away for a whole record set or a deep
 * structure; this is the glance.
 *
 * Props:
 *   value     — the output (an object; anything else is handed back as one
 *               "output" row)
 *   basePath  — `steps.<id>.output`, so a row can still be dragged as a path
 *   onInsert  — optional (path) => void; absent, clicking a row does nothing
 */
export default function OutputFieldsView({ value, basePath = '', onInsert = null }) {
    const { t } = useTranslation();
    const fields = value && typeof value === 'object' && !Array.isArray(value)
        ? sampleToFields(value, basePath)
        : [{ key: t('routines.ndv.output_word', 'output'), path: basePath, sample: value }];
    if (!fields.length) {
        return <div className="px-3 py-4 text-[11px] text-[var(--text-tertiary)] italic">{t('routines.ndv.output_empty_record', 'An empty record — no fields came out.')}</div>;
    }
    return (
        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar py-1" data-testid="output-fields">
            {fields.map(f => (
                <SourceNode key={f.path || f.key} node={f} onInsert={onInsert} depth={0} previewSample={null} />
            ))}
        </div>
    );
}
