import { useState } from 'react';
import toast from '@/components/shared/Toast';
import useConfirm from '@/components/shared/useConfirm';
import useTranslation from '@/hooks/useTranslation';
import type { TranslateFn } from '@/hooks/useTranslation';
import { ApiError, errorBody } from '@/api/mutate';
import { useWebhookSecret, useWebhookView, webhookApi, type WebhookApi, type WebhookDelivery, type WebhookSigning } from './webhookTriggerApi';

/**
 * What the owner needs to connect another system to a webhook trigger: the address, the signing
 * secret (shown ONCE, here, and kept nowhere in the browser after this component is gone), how a
 * delivery is signed, and what became of the last deliveries. The address and the secret exist
 * only for a published app; they are not part of the definition.
 */

const LINK_BTN = 'text-xs text-[var(--accent-primary)] disabled:cursor-not-allowed disabled:opacity-50';
const CODE = 'block max-w-full overflow-x-auto whitespace-pre rounded-md border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-2 py-1 font-mono text-xs text-[var(--text-primary)]';

async function copy(text: string, t: TranslateFn) {
    try {
        await navigator.clipboard.writeText(text);
        toast.success(t('studio_apps_h5.copied', 'Copied'));
    } catch {
        toast.error(t('studio_apps_h5.copy_failed', 'Your browser refused to copy. Select the text and copy it yourself.'));
    }
}

/** The recipe as a shell script a sender can paste; `<secret>` stays a placeholder on purpose. */
export function signingRecipe(url: string, s: WebhookSigning): string {
    return [
        'SECRET=\'<secret>\'',
        'BODY=\'{"hello":"world"}\'',
        'TS=$(date +%s)',
        'NONCE=$(openssl rand -hex 16)',
        'SIG=$(printf \'%s\\n%s\\n%s\' "$NONCE" "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed \'s/^.* //\')',
        `curl -X POST '${url}' \\`,
        '  -H \'Content-Type: application/json\' \\',
        `  -H "${s.timestampHeader}: $TS" \\`,
        `  -H "${s.nonceHeader}: $NONCE" \\`,
        `  -H "${s.signatureHeader}: sha256=$SIG" \\`,
        '  --data "$BODY"',
    ].join('\n');
}

function statusText(status: string, t: TranslateFn): string {
    switch (status) {
        case 'accepted': return t('studio_apps_h5.status.accepted', 'Accepted');
        case 'bad_signature': return t('studio_apps_h5.status.bad_signature', 'Refused: the signature did not fit');
        case 'stale_timestamp': return t('studio_apps_h5.status.stale_timestamp', 'Refused: the timestamp was too far from now');
        case 'replay': return t('studio_apps_h5.status.replay', 'Sent again: nothing started');
        case 'rate_limited': return t('studio_apps_h5.status.rate_limited', 'Refused: too many deliveries in a minute');
        case 'disarmed': return t('studio_apps_h5.status.disarmed', 'Refused: the trigger was not armed');
        case 'busy': return t('studio_apps_h5.status.busy', 'Not started: a run was still going');
        case 'invalid_body': return t('studio_apps_h5.status.invalid_body', 'Refused: the body was not usable JSON');
        default: return t('studio_apps_h5.status.received', 'Received');
    }
}

function Deliveries({ rows }: { rows: WebhookDelivery[] }) {
    const { t, locale } = useTranslation();
    if (!rows.length) return <p className="text-xs text-[var(--text-tertiary)]">{t('studio_apps_h5.no_deliveries', 'No deliveries yet.')}</p>;
    return (
        <ul className="flex flex-col gap-0.5 text-xs text-[var(--text-secondary)]" data-testid="webhook-deliveries">
            {rows.map((d) => (
                <li key={d.id} className="flex flex-wrap gap-x-3" data-delivery-status={d.status}>
                    <span>{d.receivedAt ? new Date(d.receivedAt).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'medium' }) : ''}</span>
                    <span className={d.status === 'accepted' ? 'text-[var(--success)]' : ''}>{statusText(d.status, t)}</span>
                    <span className="text-[var(--text-tertiary)]">{t('studio_apps_h5.bytes', '{count} bytes', { count: d.bodyBytes })}</span>
                    {d.bodyHash ? <span className="font-mono text-[var(--text-tertiary)]">{d.bodyHash}</span> : null}
                </li>
            ))}
        </ul>
    );
}

export interface WebhookTriggerDetailsProps { appId: string; triggerId: string; disabled?: boolean; api?: WebhookApi }

export default function WebhookTriggerDetails({ appId, triggerId, disabled = false, api = webhookApi }: WebhookTriggerDetailsProps) {
    const { t, locale } = useTranslation();
    const { confirm, confirmDialog } = useConfirm();
    const view = useWebhookView(api, appId, triggerId, !!appId && !!triggerId);
    const secret = useWebhookSecret(api, appId, triggerId);
    // The one place the secret is held: this component's state. Hiding it forgets it.
    const [shown, setShown] = useState<string | null>(null);

    const ask = (how: 'reveal' | 'rotate') => secret.mutate(how, {
        onSuccess: (out) => setShown(out.secret),
        onError: (err) => {
            const reason = err instanceof ApiError ? errorBody(err)?.error : null;
            toast.error(typeof reason === 'string' && reason ? reason : t('studio_apps_h5.secret_failed', 'The secret could not be read. Try again.'));
        },
    });
    const rotate = async () => {
        const ok = await confirm({
            title: t('studio_apps_h5.rotate_title', 'Make a new secret?'),
            description: t('studio_apps_h5.rotate_body', 'The new secret is shown once. The old one keeps working for a short while, so you can move the sender over; after that only the new one is accepted.'),
            confirmLabel: t('studio_apps_h5.rotate_confirm', 'Make a new secret'),
        });
        if (ok) ask('rotate');
    };

    if (view.isError) return <p className="text-xs text-[var(--error)]" role="alert">{t('studio_apps_h5.view_failed', 'The address of this trigger could not be read.')}</p>;
    if (!view.data) return null;
    const { endpoint, signing, deliveries } = view.data;
    if (!endpoint) {
        return <p className="text-xs text-[var(--text-tertiary)]" data-webhook="none">{t('studio_apps_h5.no_endpoint', 'This trigger gets its address and its secret when you publish the app.')}</p>;
    }
    return (
        <div className="flex flex-col gap-1.5 rounded-md border border-[var(--border-default)] p-2" data-webhook="ready">
            <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-[var(--text-secondary)]">{t('studio_apps_h5.address', 'Address')}</span>
                <code className={`${CODE} min-w-0 flex-1`} data-testid="webhook-url">{endpoint.url}</code>
                <button type="button" className={LINK_BTN} onClick={() => copy(endpoint.url, t)}>{t('studio_apps_h5.copy', 'Copy')}</button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-[var(--text-secondary)]">{t('studio_apps_h5.secret', 'Secret')}</span>
                {shown ? (
                    <>
                        <code className={`${CODE} min-w-0 flex-1`} data-testid="webhook-secret">{shown}</code>
                        <button type="button" className={LINK_BTN} onClick={() => copy(shown, t)}>{t('studio_apps_h5.copy', 'Copy')}</button>
                        <button type="button" className={LINK_BTN} onClick={() => setShown(null)}>{t('studio_apps_h5.hide', 'I saved it, hide it')}</button>
                    </>
                ) : (
                    <>
                        {endpoint.secretAvailable
                            ? <button type="button" className={LINK_BTN} disabled={disabled || secret.isPending} onClick={() => ask('reveal')}>{t('studio_apps_h5.show_once', 'Show the secret (once)')}</button>
                            : <span className="text-xs text-[var(--text-tertiary)]">{t('studio_apps_h5.shown_before', 'Shown before. It cannot be shown again.')}</span>}
                        <button type="button" className={LINK_BTN} disabled={disabled || secret.isPending} onClick={rotate}>{t('studio_apps_h5.rotate', 'Make a new secret')}</button>
                    </>
                )}
            </div>
            {shown ? <p className="text-xs text-[var(--warning)]" role="status">{t('studio_apps_h5.once_warning', 'Copy the secret now and keep it somewhere safe. It is shown this once; after that you can only make a new one.')}</p> : null}
            {endpoint.previousValidUntil ? (
                <p className="text-xs text-[var(--text-secondary)]">
                    {t('studio_apps_h5.previous_until', 'The previous secret still works until {time}.', { time: new Date(endpoint.previousValidUntil).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' }) })}
                </p>
            ) : null}
            <details className="text-xs text-[var(--text-secondary)]">
                <summary className="cursor-pointer">{t('studio_apps_h5.recipe_title', 'How the other system signs a delivery')}</summary>
                <p className="mt-1">
                    {t('studio_apps_h5.recipe_body', 'Send a POST with a JSON body of at most {bytes} bytes. Sign the delivery id, a line break, the time in seconds, a line break and the body, exactly as sent, with HMAC-SHA256 and the secret. The time may be at most {seconds} seconds off, and a delivery id is accepted once: sending the same delivery again starts nothing.', { bytes: signing.maxBodyBytes, seconds: signing.toleranceSeconds })}
                </p>
                <code className={`${CODE} mt-1`} data-testid="webhook-recipe">{signingRecipe(endpoint.url, signing)}</code>
                <button type="button" className={`${LINK_BTN} mt-1`} onClick={() => copy(signingRecipe(endpoint.url, signing), t)}>{t('studio_apps_h5.copy_recipe', 'Copy the example')}</button>
                <p className="mt-1">{t('studio_apps_h5.recipe_reads', 'The action reads the body as trigger.webhook.body. Treat it like a form a stranger filled in: check what you use.')}</p>
                <p className="mt-1">{t('studio_apps_h5.privacy', 'What the other system puts in a delivery is its choice. The run keeps it like any other value of a run, and it leaves Bee Flow only the way a run may send things: by e-mail.')}</p>
            </details>
            <div>
                <span className="text-xs font-medium text-[var(--text-secondary)]">{t('studio_apps_h5.deliveries', 'Last deliveries')}</span>
                <Deliveries rows={deliveries} />
            </div>
            {confirmDialog}
        </div>
    );
}
