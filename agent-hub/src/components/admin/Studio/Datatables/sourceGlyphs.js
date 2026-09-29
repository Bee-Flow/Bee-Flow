/**
 * The glyph a SOURCE MIRROR wears — the React half of datatableDisplay's
 * `tableIconOf`, kept apart so that module stays free of React and lucide
 * (it is imported by pure tests, by the builder's mapping helpers, by the
 * meeting-notes destination menu). Modelled on shared/kindColors.js: a leaf
 * that imports icons and nothing else.
 *
 * A Nextcloud Tables mirror is a cloud; a spreadsheet mirror is a sheet. The
 * grid stays the ordinary table's — a list of twenty must say at a glance
 * which tables are really somebody else's.
 *
 * Consumers render with `React.createElement(glyph, props)` (the house idiom
 * for a component chosen at run time; `react-hooks/static-components` flags
 * a component created during render, and a lookup is not a creation).
 */
import { ClipboardList, Cloud, FileSpreadsheet } from 'lucide-react';
import { tableIconOf } from './datatableDisplay';

export const SOURCE_GLYPHS = Object.freeze({
    nextcloud: Cloud,
    spreadsheet: FileSpreadsheet,
    form: ClipboardList,
});

/** The component for a table's source glyph, or null for "the kind's own icon". */
export function sourceGlyphOf(table) {
    const name = tableIconOf(table);
    return name ? SOURCE_GLYPHS[name] || null : null;
}
