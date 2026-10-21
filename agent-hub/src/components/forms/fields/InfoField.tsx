import React from 'react';
import type { FormFieldDef } from '../PublicFormRenderer.types';
import { FormRichText } from './FormRichText';

/**
 * A block of text between the questions. Display only: it collects nothing and
 * is never submitted. `content` is markdown and goes through FormRichText,
 * which renders raw HTML as plain text — it can carry run data, so it must
 * never become live markup.
 *
 * A group's header (the question repeated once per list item) is the same
 * block shown as a sub-heading above its items.
 */
export default function InfoField({ field }: { field: FormFieldDef }) {
    const content = typeof field.content === 'string' ? field.content : '';
    const label = field.label || '';
    if (!label && !content) return null;
    const heading = field.groupHeader
        ? <h3 id={`ff_${field.name}`} className="text-sm font-semibold text-[var(--text-primary)]">{label}</h3>
        : <p className="text-sm font-medium text-[var(--text-primary)]">{label}</p>;
    return (
        <div className="flex flex-col gap-1 text-left" data-testid={`form-info-${field.name}`}>
            {label ? heading : null}
            {content ? <FormRichText className="text-sm text-[var(--text-secondary)]">{content}</FormRichText> : null}
        </div>
    );
}
