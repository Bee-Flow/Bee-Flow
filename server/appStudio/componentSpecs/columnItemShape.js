// @typecheck strict
/**
 * App Studio catalog — the tail of a column item that `table` and `data_grid`
 * share: both render through the same cellValue module, so the keys that
 * colour, explain, act on, format and template a column are written once.
 */

'use strict';

const { COLOR_ROLES } = require('./styleKnobs');
const { formatOptionsSpec } = require('./objectShapes');
const { cellStyleSpec } = require('./styleRuleShape');
const { columnTemplateSpec } = require('./itemTemplates');

/** A fresh copy per call, so no two components share one object. */
function sharedColumnItemShape() {
    return {
        // Per-value tones for a `badge`/`tags` column whose table has no colour
        // of its own. Same shape as list.badgeToneMap. On a text/number column
        // the resolved tone colours the text itself (there is no pill to colour).
        toneMap: {
            type: 'list', maxItems: 16,
            itemShape: {
                value: { type: 'string', required: true, maxLen: 200 },
                label: { type: 'string', maxLen: 80 },
                tone: { type: 'enum', values: COLOR_ROLES, default: 'neutral' },
            },
        },
        // One line explaining what lives in this column, shown on hover over its
        // header. Labels get abbreviated to fit ("Snijkw.", "Afbr.", "Cert.")
        // and then only the person who built the table knows what the numbers
        // under them mean; everyone else guesses, or asks whoever built it.
        help: { type: 'string', maxLen: 200 },
        // Make THIS cell a button. A status column is the thing people reach for
        // when they want to change the status, and sending them to a separate
        // button at the end of the row to do it is a detour they have to be
        // taught. The action gets the row as `item` and as form values, like a
        // row action.
        actionId: { type: 'string', maxLen: 20 },
        // Schema 3: how this column writes its numbers and dates.
        formatOptions: formatOptionsSpec(
            'How this column writes its numbers, amounts and dates.',
            'It applies to the number, currency, percent, progress, date, datetime and relative formats of the column.',
        ),
        // Schema 3: per-cell conditional style from the row's values (styleRuleShape.js).
        cellStyle: cellStyleSpec('Style of a cell while a formula over its row is true.'),
        // Schema 3: what a `format: 'template'` column writes (./itemTemplates.js).
        template: columnTemplateSpec(),
    };
}

module.exports = { sharedColumnItemShape };
