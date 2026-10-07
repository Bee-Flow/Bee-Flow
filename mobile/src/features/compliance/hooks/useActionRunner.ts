/**
 * Runs a registry action the way its spec asks: confirm first (fixed words or
 * words about the record), open a form or an attestation sheet first, hand a
 * file to the share sheet, or just send the request — then say so in a toast
 * (fixed, or built from the write's response) and, when asked, go back. A
 * failed write reads the action's own words when it has them. An action that
 * is disabled for the record (`disabledReason`) is refused. The sheets are
 * rendered by components/ActionSheets from `pending`.
 */

import { useRouter } from 'expo-router';
import { useState } from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation, type TranslateFn } from '@/core/i18n';
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
    /** Send a request built from a sheet's values; throws (in the action's words) so the sheet shows the error. */
    submit: (request: WriteRequest, action: ActionSpec, rec?: Rec) => Promise<void>;
    context: (values?: FormValues) => RequestContext;
}

/** The action's words for a failed write, as an Error a sheet or toast can show. */
export function actionError(action: Pick<ActionSpec, 'errorText'>, err: unknown, t: TranslateFn): unknown {
    const text = action.errorText?.(err, t);
    return text ? new Error(text) : err;
}

function successText(action: ActionSpec, result: unknown, rec: Rec, t: TranslateFn): string {
    const s = action.success;
    if (typeof s === 'function') return s(result, rec, t);
    return s ? labelText(s, t) : t('common.saved', 'Saved');
}

function confirmText(action: ActionSpec, rec: Rec, t: TranslateFn): string | null {
    const c = action.confirm;
    if (!c) return null;
    return typeof c === 'function' ? c(rec, t) : labelText(c, t);
}

export function useActionRunner(context: Rec | null = null, userName?: (id: string) => string | null): ActionRunner {
    const t = useTranslation();
    const router = useRouter();
    const { toast } = useToast();
    const confirm = useConfirm();
    const write = useComplianceWrite();
    const [pending, setPending] = useState<PendingAction | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const ctx = (): RequestContext => ({ t, context, now: Date.now(), userName });

    const submit = async (request: WriteRequest, action: ActionSpec, rec?: Rec) => {
        let result: unknown;
        try {
            result = await write.mutateAsync(request);
        } catch (err) {
            throw actionError(action, err, t);
        }
        toast(successText(action, result, rec ?? pending?.rec ?? {}, t), 'success');
        if (action.afterSuccess === 'back') router.back();
    };

    const direct = async (action: ActionSpec, rec: Rec) => {
        setBusy(action.id);
        try {
            if (action.download) await shareDownload(action.download(rec));
            else if (action.request) await submit(action.request(rec, {}, ctx()), action, rec);
        } catch (err) {
            toast(describeError(err).message, 'error');
        } finally {
            setBusy(null);
        }
    };

    const run = async (action: ActionSpec, rec: Rec) => {
        if (action.disabledReason?.(rec)) return;
        if (action.fields?.length || action.attest) {
            setPending({ action, rec });
            return;
        }
        const message = confirmText(action, rec, t);
        if (message) {
            const ok = await confirm({
                title: labelText(action.label, t),
                message,
                confirmLabel: labelText(action.label, t),
                tone: action.danger ? 'destructive' : 'primary',
            });
            if (!ok) return;
        }
        await direct(action, rec);
    };

    return { pending, busy, run, close: () => setPending(null), submit, context: ctx };
}
