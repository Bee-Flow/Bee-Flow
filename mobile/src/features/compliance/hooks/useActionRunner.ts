/**
 * Runs a registry action the way its spec asks: confirm first, open a form or
 * an attestation sheet first, hand a file to the share sheet, or just send the
 * request — then say so in a toast. The sheets themselves are rendered by
 * components/ActionSheets from `pending`.
 */

import { useState } from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useConfirm } from '@/shared/patterns';
import { useToast } from '@/shared/ui';

import { useComplianceWrite } from './mutations';
import { shareDownload } from '../api/endpoints';
import { labelText } from '../model/fields';
import type { ActionSpec, FormValues, Rec, RequestContext, WriteRequest } from '../model/types';

export interface PendingAction {
    action: ActionSpec;
    rec: Rec;
}

export interface ActionRunner {
    pending: PendingAction | null;
    busy: string | null;
    run: (action: ActionSpec, rec: Rec) => Promise<void>;
    close: () => void;
    /** Send a request built from a sheet's values; throws so the sheet shows the error. */
    submit: (request: WriteRequest, action: ActionSpec) => Promise<void>;
    context: (values?: FormValues) => RequestContext;
}

export function useActionRunner(context: Rec | null = null): ActionRunner {
    const t = useTranslation();
    const { toast } = useToast();
    const confirm = useConfirm();
    const write = useComplianceWrite();
    const [pending, setPending] = useState<PendingAction | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const ctx = (): RequestContext => ({ t, context, now: Date.now() });

    const done = (action: ActionSpec) =>
        toast(action.success ? labelText(action.success, t) : t('common.saved', 'Saved'), 'success');

    const submit = async (request: WriteRequest, action: ActionSpec) => {
        await write.mutateAsync(request);
        done(action);
    };

    const direct = async (action: ActionSpec, rec: Rec) => {
        setBusy(action.id);
        try {
            if (action.download) await shareDownload(action.download(rec));
            else if (action.request) await submit(action.request(rec, {}, ctx()), action);
        } catch (err) {
            toast(describeError(err).message, 'error');
        } finally {
            setBusy(null);
        }
    };

    const run = async (action: ActionSpec, rec: Rec) => {
        if (action.fields?.length || action.attest) {
            setPending({ action, rec });
            return;
        }
        if (action.confirm) {
            const ok = await confirm({
                title: labelText(action.label, t),
                message: labelText(action.confirm, t),
                confirmLabel: labelText(action.label, t),
                tone: action.danger ? 'destructive' : 'primary',
            });
            if (!ok) return;
        }
        await direct(action, rec);
    };

    return { pending, busy, run, close: () => setPending(null), submit, context: ctx };
}
