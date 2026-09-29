import type { ComponentType } from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { humanizeFieldKey as humanizeFieldKeyJs } from '../flow/displayHelpers';
import FieldKindIconJs from '../mapping/FieldKindIcon';
import { KIND_WORD as KIND_WORD_JS, isPlaceholder as isPlaceholderJs, kindOfValue as kindOfValueJs } from '../mapping/fieldKinds';
import { isTechnicalKey } from './columns';
import { isPlainObject } from './valueHelpers';

const FieldKindIcon = FieldKindIconJs as unknown as ComponentType<{ kind: string; size?: number; className?: string }>;
const kindOfValue = kindOfValueJs as (v: unknown) => string;
const isPlaceholder = isPlaceholderJs as (v: unknown) => boolean;
const humanizeFieldKey = humanizeFieldKeyJs as (key: string) => string;
const KIND_WORD = KIND_WORD_JS as Record<string, { key: string; en: string }>;

/** Fields listed before "+ n more". */
const MAX_FIELDS = 8;

/** The kind a described sample promises: a `'<string>'` placeholder is text. */
function expectedKind(v: unknown): string {
    if (typeof v === 'string' && isPlaceholder(v)) return 'text';
    return kindOfValue(v);
}

/**
 * What the step will hand on once it succeeds, before any run has shown it
 * (artboard 4a): the fields the describers promise, each "no value yet".
 * Null when there is nothing to promise.
 */
export default function ExpectedFields({ sample }: { sample: unknown }) {
    const { t } = useTranslation();
    if (!isPlainObject(sample)) return null;
    const entries = Object.entries(sample);
    const readable = entries.filter(([k]) => !isTechnicalKey(k));
    const list = (readable.length ? readable : entries);
    if (!list.length) return null;
    const shown = list.slice(0, MAX_FIELDS);
    const rest = entries.length - shown.length;
    return (
        <div className="flex flex-col gap-1.5 text-xs" data-testid="output-expected-fields">
            <div className="flex items-baseline gap-1.5">
                <span className="font-semibold">{t('routines.output.will_return', 'This step will return')}</span>
                <span className="text-[var(--text-tertiary)]">{t('routines.output.once_it_succeeds', 'once it succeeds')}</span>
            </div>
            {shown.map(([k, v]) => {
                const kind = expectedKind(v);
                const word = KIND_WORD[kind];
                return (
                    <div key={k} className="flex items-center gap-2 px-2.5 py-[7px] rounded-lg bg-[var(--bg-card)] border border-[var(--border-default)] min-w-0">
                        <FieldKindIcon kind={kind} size={13} className="shrink-0 text-[var(--text-secondary)]" />
                        <span className="font-medium truncate">{humanizeFieldKey(k) || k}</span>
                        {word && kind !== 'unknown' && <span className="text-[var(--text-tertiary)] shrink-0">{t(word.key, word.en)}</span>}
                        <span className="ml-auto text-[var(--text-tertiary)] italic shrink-0">{t('routines.output.no_value_yet', 'no value yet')}</span>
                    </div>
                );
            })}
            {rest > 0 && (
                <div className="text-[var(--text-tertiary)] px-0.5">{t('routines.output.more_fields', '+ {count} more fields', { count: rest })}</div>
            )}
        </div>
    );
}
