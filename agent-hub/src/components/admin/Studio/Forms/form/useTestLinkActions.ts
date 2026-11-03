import { useCallback, useState } from 'react';
import type { FormTestLinkApi } from '@/api/formTestLink';
import { useTranslation } from '@/hooks/useTranslation';
import useConfirm from '@/components/shared/useConfirm';

/**
 * What the test link card (TestLinkCard) does: make a link (asking first when
 * it replaces one), stop it (asking first), copy its address. Each change
 * reloads the host's form detail, which carries the link.
 */
export default function useTestLinkActions({ automationId, hasLink, href, api, onChanged }: {
    automationId: string;
    hasLink: boolean;
    href: string | null;
    api: FormTestLinkApi;
    onChanged: (() => Promise<unknown> | void) | null;
}) {
    const { t } = useTranslation();
    const { confirm, confirmDialog } = useConfirm();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);

    const run = useCallback(async (action: () => Promise<unknown>) => {
        setBusy(true);
        setError(null);
        try {
            await action();
            if (onChanged) await onChanged();
        } catch (e) {
            setError((e as Error)?.message || t('forms.test_link.failed', 'Could not change the test link.'));
        } finally {
            setBusy(false);
        }
    }, [onChanged, t]);

    const create = useCallback(async () => {
        const ok = !hasLink || await confirm({
            title: t('forms.test_link.renew_title', 'Make a new test link?'),
            description: t('forms.test_link.renew_body', 'The current test link stops working immediately.'),
            confirmLabel: t('forms.test_link.renew_confirm', 'Make a new link'),
            cancelLabel: t('forms.new.cancel', 'Cancel'),
            destructive: true,
        });
        if (ok) await run(() => api.create(automationId));
    }, [api, automationId, confirm, hasLink, run, t]);

    const revoke = useCallback(async () => {
        const ok = await confirm({
            title: t('forms.test_link.revoke_title', 'Stop the test link?'),
            description: t('forms.test_link.revoke_body', 'Anyone who has it sees “not available” from now on. Test runs that already started go on.'),
            confirmLabel: t('forms.test_link.revoke_confirm', 'Stop it'),
            cancelLabel: t('forms.new.cancel', 'Cancel'),
            destructive: true,
        });
        if (ok) await run(() => api.revoke(automationId));
    }, [api, automationId, confirm, run, t]);

    const copy = useCallback(async () => {
        if (!href) return;
        try {
            await navigator.clipboard.writeText(href);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            setError(t('forms.studio.copy_failed', 'Could not copy the link — your browser refused clipboard access.'));
        }
    }, [href, t]);

    return { busy, error, copied, create, revoke, copy, confirmDialog };
}
