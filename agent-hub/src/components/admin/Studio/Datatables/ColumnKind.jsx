import { CircleDot, Link2 } from 'lucide-react';
import React from 'react';
import { columnTypeKind } from './datatableDisplay';
import FieldKindIcon from '../../../automation/Builder/mapping/FieldKindIcon';
import { KIND_WORD } from '../../../automation/Builder/mapping/fieldKinds';

/**
 * A column's SOORT as the artboard draws it (Datatables 1d): the mapping
 * panel's own glyph, then the same word a person already met in the builder
 * — "tekst", "getal", "ja/nee", "datum", "één uit een lijst", "lijst",
 * "bestand".
 *
 * It wraps `mapping/FieldKindIcon` rather than replacing it, so a datatable
 * column and a step's output field cannot end up with two different icons
 * for the same idea. The one glyph it supplies itself is `choice`: that kind
 * is new with this wave, and until FieldKindIcon's own map carries it a
 * question mark would sit on every dropdown column. (The shared edit that
 * adds `choice: CircleDot` there is filed with this change; when it lands
 * this fallback simply stops firing.)
 *
 * `relation` is the second: a link to one row of another table, met only on
 * a table that mirrors a Nextcloud table. The builder's own kinds do not know
 * it (a routine never authors one), so the word lives here.
 */
const RELATION_WORD = { key: 'datatables.kind_relation', en: 'link to a row' };

export function ColumnKindIcon({ kind, size = 14, style, title }) {
    if (kind === 'relation') {
        return (
            <Link2
                size={size}
                style={style}
                aria-label={title || RELATION_WORD.en}
                data-kind="relation"
            />
        );
    }
    if (kind === 'choice') {
        return (
            <CircleDot
                size={size}
                style={style}
                aria-label={title || KIND_WORD.choice.en}
                data-kind="choice"
            />
        );
    }
    return <FieldKindIcon kind={kind} size={size} style={style} title={title} />;
}

/** The kind word in the reader's language — the builder's own key, never a second copy. */
export function kindWord(t, kind) {
    const word = kind === 'relation' ? RELATION_WORD : (KIND_WORD[kind] || KIND_WORD.unknown);
    return t(word.key, word.en);
}

/**
 * Icon + word for one datatable column type, the pair the designer's "Soort"
 * cell and the row grid's column headers both show.
 */
export default function ColumnKind({ t, type, size = 14, iconOnly = false, className = '' }) {
    const kind = columnTypeKind(type);
    const word = kindWord(t, kind);
    if (iconOnly) {
        return <ColumnKindIcon kind={kind} size={size} title={word} style={{ color: 'var(--text-secondary)' }} />;
    }
    return (
        <span className={`inline-flex items-center gap-1.5 min-w-0 ${className}`}>
            <ColumnKindIcon kind={kind} size={size} title={word} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
            <span className="truncate">{word}</span>
        </span>
    );
}
