/**
 * The sheet an action opens before it sends anything: its fields in a form
 * sheet (its own submit label and description, prefilled from the record
 * when it asks, with its cross-field rules), or the attestation sheet.
 * Driven by useActionRunner's `pending`.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';

import { AttestSheet } from './AttestSheet';
import { RecordFormSheet } from './RecordFormSheet';
import type { ActionRunner } from '../hooks/useActionRunner';
import { initialValues, labelText } from '../model/fields';

export function ActionSheets({ runner }: { runner: ActionRunner }) {
    const t = useTranslation();
    const pending = runner.pending;
    if (!pending) return null;
    const { action, rec } = pending;
    const title = labelText(action.label, t);

    if (action.attest) {
        const attest = action.attest;
        return (
            <AttestSheet
                spec={attest}
                rec={rec}
                title={title}
                onClose={runner.close}
                onSubmit={(body) => runner.submit({ method: 'POST', path: attest.path(rec), body }, action, rec)}
            />
        );
    }
    const fields = action.fields ?? [];
    const request = action.request;
    if (!request) return null;
    const description = typeof action.description === 'function' ? action.description(rec, t) : action.description ? labelText(action.description, t) : null;
    const validate = action.validate;
    return (
        <RecordFormSheet
            title={title}
            subtitle={description ?? undefined}
            submitLabel={action.submitLabel ? labelText(action.submitLabel, t) : title}
            fields={fields}
            initial={initialValues(fields, action.prefill ? rec : null)}
            rec={rec}
            danger={action.danger}
            validate={validate ? (values) => validate(values, rec, t) : undefined}
            onClose={runner.close}
            onSubmit={(values) => runner.submit(request(rec, values, runner.context(values)), action, rec)}
        />
    );
}
