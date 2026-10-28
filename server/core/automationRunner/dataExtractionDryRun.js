// @typecheck strict
'use strict';
/**
 * The dry-run sample of a `data_extraction` step (see execDataExtraction.js).
 */

/**
 * The words a sample names its field with: the author's own description when
 * there is one (first sentence, kept short), else the field name.
 * @param {{ name: string, description?: string }} f
 */
function sampleLabel(f) {
    const desc = (f.description || '').split(/[.\n]/)[0].trim();
    const label = desc || f.name.replace(/_/g, ' ');
    return label.length > 60 ? `${label.slice(0, 57).trimEnd()}...` : label;
}

/**
 * Typed sample values for the declared fields: the declared names and types,
 * and values that echo each field's own description (so a downstream preview
 * reads like the step the author wrote). Numbers differ per position so two
 * number fields are not mistaken for one another.
 * @param {Array<{ name: string, type: string, description?: string }>} fields
 * @returns {Record<string, string | number | boolean>}
 */
function synthesiseDryRunExtraction(fields) {
    /** @type {Record<string, string | number | boolean>} */
    const out = {};
    fields.forEach((f, i) => {
        switch (f.type) {
            case 'number':  out[f.name] = Math.round((123.45 + i * 111.11) * 100) / 100; break;
            case 'boolean': out[f.name] = true; break;
            case 'date':    out[f.name] = '2026-01-15'; break;
            default:        out[f.name] = `Sample ${sampleLabel(f)}`; break;
        }
    });
    return out;
}

module.exports = { synthesiseDryRunExtraction };
