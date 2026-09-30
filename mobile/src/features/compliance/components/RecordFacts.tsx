/**
 * A record's facts: its status first, the short facts as label/value rows,
 * each long text (a description, a justification) as its own group with the
 * full text. A fact with nothing in it is left out rather than shown as a dash.
 */

import React from 'react';

import { Group, InfoRow, NoteRow } from '@/shared/ui';

import { formatValue, labelText, statusOf } from '../model/fields';
import type { FieldSpec, Formatter, Rec, RecordTone, RecordType } from '../model/types';

const isLong = (spec: FieldSpec) => spec.kind === 'multiline';

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
    const short = shown(type.facts.filter((f) => !isLong(f)));
    const long = shown(type.facts.filter(isLong));
    return (
        <>
            <Group>
                {status ? (
                    <InfoRow label={fmt.t('common.status', 'Status')} value={labelText(status.label, fmt.t)} tone={INK[status.tone ?? 'neutral']} />
                ) : null}
                {short.map(({ spec, text }) => (
                    <InfoRow key={spec.key} label={labelText(spec.label, fmt.t)} value={text} />
                ))}
            </Group>
            {long.map(({ spec, text }) => (
                <Group key={spec.key} title={labelText(spec.label, fmt.t)}>
                    <NoteRow>{text}</NoteRow>
                </Group>
            ))}
        </>
    );
}
