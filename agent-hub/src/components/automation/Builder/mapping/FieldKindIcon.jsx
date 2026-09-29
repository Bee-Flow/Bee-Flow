import { Type, Mail, Hash, ToggleRight, Calendar, CircleDot, List, Folder, Table, Paperclip, CircleHelp } from 'lucide-react';
import React from 'react';
import { KIND_WORD } from './fieldKinds';

/**
 * The icon for a field kind (artboard 2c): text · email address · number · yes/no · date ·
 * one-of-a-list · list · group · table · file. Named Lucide imports only.
 *
 * Every kind in `fieldKinds.KINDS` needs a glyph of its own, and the test
 * beside this file asserts exactly that. `CircleHelp` is the glyph for
 * `unknown` — "not seen yet" — so borrowing it as the fallback for a kind the
 * table simply forgot makes the screen claim ignorance about a value the
 * schema fully declares. That is the fail-open shape this product does not
 * accept: `choice` sat on CircleHelp for a whole round because the entry was
 * missing, not because anything was unknown.
 *
 * `choice` is a radio dot: one of several DECLARED options, which is what
 * separates it from `list` (many values) and from `text` (no options at all).
 */
const ICON = {
    text: Type, email: Mail, number: Hash, yesno: ToggleRight, date: Calendar,
    choice: CircleDot,
    list: List, group: Folder, table: Table, file: Paperclip, unknown: CircleHelp,
};

export default function FieldKindIcon({ kind, size = 14, className = '', style = undefined, title = undefined }) {
    const Icon = ICON[kind] || CircleHelp;
    return <Icon size={size} className={className} style={style} aria-label={title || KIND_WORD[kind]?.en || kind} data-kind={kind} />;
}

export { ICON as KIND_ICON };
