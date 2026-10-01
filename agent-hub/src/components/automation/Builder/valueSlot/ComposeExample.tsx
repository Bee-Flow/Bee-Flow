import React from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { AMBER_NOTE } from '../flow/settings/formStyles';
import type { Example } from './composeValue';

/**
 * The example under a ComposeField: what the run makes of the text on the
 * sample. A list a `{{ }}` template puts in as JSON gets a note: neutral in
 * a JSON body (that is what it wants), otherwise how to get readable text:
 * by changing the text (it is then written as a compose) where the field
 * takes one, else with a join in an Edit data step.
 */
export default function ComposeExample({ example, listAs, liftsOnEdit }: {
    example: Example;
    listAs: 'text' | 'json' | 'markdown';
    /** Changing the text writes it as a compose, which renders the list readably. */
    liftsOnEdit: boolean;
}) {
    const { t } = useTranslation();
    const { list } = example;
    let note: React.ReactNode = null;
    if (list && listAs === 'json') {
        note = <div>{t('routines.builder.template_array_json', 'The list goes in as JSON: {preview}', { preview: list.preview })}</div>;
    } else if (list && liftsOnEdit) {
        note = (
            <div className={AMBER_NOTE}>
                {t('mapping.compose.list_lifts', 'This list goes in as JSON text: {preview}. Change anything in this text and it goes in as readable text instead.', { preview: list.preview })}
            </div>
        );
    } else if (list) {
        note = (
            <div className={AMBER_NOTE}>
                {t('routines.builder.template_array_text', 'This list goes in as JSON text: {preview}. For plain text, join it first: add an Edit data step with a Formula field set to {expr}.', {
                    preview: list.preview,
                    expr: list.joinExpr,
                })}
            </div>
        );
    }
    return (
        <div className="text-[10px] text-[var(--text-tertiary)] space-y-0.5" data-testid="compose-example">
            <div className="uppercase tracking-wide">{t('mapping.compose.example', 'Example')}</div>
            <div className="font-mono text-[var(--text-secondary)] whitespace-pre-wrap break-words bg-[var(--bg-secondary)] rounded px-2 py-1">
                {example.text}
            </div>
            {note}
        </div>
    );
}
