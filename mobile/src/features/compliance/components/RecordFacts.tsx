/**
 * A record's facts: its status first, the short facts as label/value rows,
 * each long text (a description, a justification) as its own group with the
 * full text, and a list of more than one value as bullets. A fact's own
 * `toneOf` inks its value. A fact with nothing in it is left out rather than
 * shown as a dash.
 */

import React from 'react';

import { Group, InfoRow, NoteRow } from '@/shared/ui';

import { formatValue, labelText, statusOf } from '../model/fields';
import type { FieldSpec, Formatter, Rec, RecordTone, RecordType } from '../model/types';

const isList = (spec: FieldSpec, rec: Rec) => spec.kind === 'lines' && Array.isArray(rec[spec.key]) && (rec[spec.key] as unknown[]).length > 1;

const INK: Record<RecordTone, 'success' | 'warning' | 'error' | 'primary'> = {
    success: 'success',
    warning: 'warning',
    error: 'error',
    info: 'primary',
    neutral: 'primary',
};

export function RecordFacts({ type, rec, fmt }: { type: RecordType; rec: Rec; fmt: Formatter }) {
    const status = statusOf(type, rec);
    const shown = (list: readonly FieldSpec[]) =>
        list.map((spec) => ({ spec, text: formatValue(spec, rec[spec.key], fmt) })).filter((x): x is { spec: FieldSpec; text: string } => Boolean(x.text));
    const isLong = (f: FieldSpec) => f.kind === 'multiline' || isList(f, rec);
    const short = shown(type.facts.filter((f) => !isLong(f)));
    const long = shown(type.facts.filter(isLong));
    const toneOf = (spec: FieldSpec) => {
        const tone = spec.toneOf?.(rec[spec.key], rec);
        return tone ? INK[tone] : undefined;
    };
    const textOf = (spec: FieldSpec, text: string) =>
        isList(spec, rec) ? (rec[spec.key] as unknown[]).map((v) => `• ${String(v)}`).join('\n') : text;
    return (
        <>
            <Group>
                {status ? (
                    <InfoRow label={fmt.t('common.status', 'Status')} value={labelText(status.label, fmt.t)} tone={INK[status.tone ?? 'neutral']} />
                ) : null}
                {short.map(({ spec, text }) => (
                    <InfoRow key={spec.key} label={labelText(spec.label, fmt.t)} value={text} tone={toneOf(spec)} />
                ))}
            </Group>
            {long.map(({ spec, text }) => (
                <Group key={spec.key} title={labelText(spec.label, fmt.t)}>
                    <NoteRow>{textOf(spec, text)}</NoteRow>
                </Group>
            ))}
        </>
    );
}
