/**
 * The sheet an action opens before it sends anything: its fields in a form
 * sheet, or the attestation sheet. Driven by useActionRunner's `pending`.
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
                onSubmit={(body) => runner.submit({ method: 'POST', path: attest.path(rec), body }, action)}
            />
        );
    }
    const fields = action.fields ?? [];
    const request = action.request;
    if (!request) return null;
    return (
        <RecordFormSheet
            title={title}
            submitLabel={title}
            fields={fields}
            initial={initialValues(fields)}
            rec={rec}
            danger={action.danger}
            onClose={runner.close}
            onSubmit={(values) => runner.submit(request(rec, values, runner.context(values)), action)}
        />
    );
}
