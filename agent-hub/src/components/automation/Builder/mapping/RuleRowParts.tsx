/**
 * The two small controls a rule row adds when its field is a column of a list
 * inside the item, or a File type:
 *
 *   [any attachment ▾] [Mime type] [contains ▾] [pdf]
 *   [any attachment ▾] [File type] [is ▾]       [PDF ▾]
 *
 * The quantifier is always explicit ("any / every / no attachment"): a list
 * column compared as one text checks only its first or last entry, which is
 * how a rule built by clicking used to keep nothing.
 */
import { FILE_TYPE_KEYS } from '@shared/expr/rules.mjs';
import useTranslation from '../../../../hooks/useTranslation';
import { denseInputClass } from '../flow/settings/formStyles';

type Translate = (key: string, fallback: string, vars?: Record<string, unknown>) => string;
export type Quantifier = 'any' | 'every' | 'none';

const QUANTIFIERS: ReadonlyArray<{ key: Quantifier; en: string }> = [
    { key: 'any', en: 'any {name}' },
    { key: 'every', en: 'every {name}' },
    { key: 'none', en: 'no {name}' },
];

/** The English of `condition_node.file_type.<key>`. */
const FILE_TYPE_EN: Readonly<Record<string, string>> = {
    pdf: 'PDF', word: 'Word', excel: 'Excel or CSV', powerpoint: 'PowerPoint', image: 'Image',
    text: 'Text', archive: 'Archive (zip)', audio: 'Audio', video: 'Video', other: 'Other',
};

/** A file type key as a person reads it ("powerpoint" → "PowerPoint"). */
export function fileTypeName(key: string, t: Translate | null = null): string {
    const en = FILE_TYPE_EN[key];
    if (!en) return key;
    return t ? t(`condition_node.file_type.${key}`, en) : en;
}

/** "any attachment" / "every attachment" / "no attachment" for one entry named `name`. */
export function quantifierText(quantifier: string, name: string, t: Translate | null = null): string {
    const q = QUANTIFIERS.find((x) => x.key === quantifier) || QUANTIFIERS[0];
    return t ? t(`condition_node.quantifier.${q.key}`, q.en, { name }) : q.en.replace('{name}', name);
}

interface QuantifierSelectProps {
    value: string | undefined;
    /** One entry of the list, lower case: "attachment". */
    listName: string;
    onChange: (next: Quantifier) => void;
}

export function QuantifierSelect({ value, listName, onChange }: QuantifierSelectProps) {
    const { t } = useTranslation();
    return (
        <select
            value={value || 'any'}
            onChange={(e) => onChange(e.target.value as Quantifier)}
            aria-label={t('condition_node.quantifier.aria', 'Which {name}', { name: listName })}
            className={denseInputClass('shrink-0 max-w-[45%] @max-[279px]/rule:max-w-none')}
        >
            {QUANTIFIERS.map((q) => (
                <option key={q.key} value={q.key}>{quantifierText(q.key, listName, t)}</option>
            ))}
        </select>
    );
}

interface FileTypeSelectProps {
    /** The row's value binding; a File type is always a literal key. */
    value: { kind?: string; value?: unknown } | null | undefined;
    onChange: (next: { kind: 'literal'; value: string }) => void;
}

export function FileTypeSelect({ value, onChange }: FileTypeSelectProps) {
    const { t } = useTranslation();
    const current = value?.kind === 'literal' && typeof value.value === 'string' ? value.value : '';
    // A saved value that is no key (typed before File type existed) stays
    // selectable instead of silently reading as "Choose a file type".
    const keys: string[] = current && !FILE_TYPE_KEYS.includes(current) ? [...FILE_TYPE_KEYS, current] : [...FILE_TYPE_KEYS];
    return (
        <select
            value={current}
            onChange={(e) => onChange({ kind: 'literal', value: e.target.value })}
            aria-label={t('condition_node.file_type.label', 'File type')}
            className={denseInputClass('w-full')}
        >
            <option value="" disabled>{t('condition_node.file_type.choose', 'Choose a file type')}</option>
            {keys.map((k) => <option key={k} value={k}>{fileTypeName(k, t)}</option>)}
        </select>
    );
}
