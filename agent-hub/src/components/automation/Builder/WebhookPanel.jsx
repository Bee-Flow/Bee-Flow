import { Webhook, Copy, Check, Eye, EyeOff, Plus } from 'lucide-react';
import React from 'react';
import useWebhooks, { webhookUrl, maskSecret } from './webhooks/useWebhooks';
import useTranslation from '../../../hooks/useTranslation';

/**
 * Manage signed inbound webhook URLs for one automation — the full manager,
 * rendered in Settings › Advanced (handoff 5, artboard 5e-7). Lists every
 * webhook attached to the automation regardless of which trigger node it is
 * scoped to.
 *
 * The compact per-trigger-node view lives in
 * `webhooks/TriggerWebhookPanel.jsx`; both share all their behaviour via
 * `webhooks/useWebhooks.js`, which also documents the HMAC signing contract.
 */
export default function WebhookPanel({ automation }) {
    const { t } = useTranslation();
    const wh = useWebhooks(automation);

    if (!automation?.id) return null;

    return (
        <div className="flex flex-col gap-2.5 text-[12px]">
            <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold text-[var(--text-primary)]">{t('routines.settings.webhooks', 'Webhooks')}</span>
                <span className="text-[var(--text-tertiary)]">{t('routines.settings.webhooks_hint', 'let another system start this automation')}</span>
                <button
                    type="button"
                    onClick={wh.create}
                    disabled={wh.creating}
                    className="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[12px] font-medium border border-[var(--border-default)] bg-[var(--bg-card)] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-60"
                >
                    <Plus size={12} /> {wh.creating ? t('routines.settings.webhook_creating', 'Creating…') : t('routines.settings.webhook_create', 'Create webhook')}
                </button>
            </div>
            {wh.errorMsg && <div role="alert" className="text-[var(--error)]">{wh.errorMsg}</div>}
            {wh.loading && wh.webhooks.length === 0 ? (
                <div className="text-[var(--text-tertiary)]">{t('common.loading', 'Loading…')}</div>
            ) : wh.webhooks.length === 0 ? (
                <div className="text-[var(--text-tertiary)]">{t('routines.settings.webhooks_none', 'No webhooks yet.')}</div>
            ) : (
                <ul className="flex flex-col gap-2">
                    {wh.webhooks.map((row) => (
                        <WebhookRow key={row.id} row={row} ctl={wh} />
                    ))}
                </ul>
            )}
        </div>
    );
}

const ROW_ACTION = 'px-2 py-0.5 rounded-md text-[12px] font-medium hover:bg-[var(--bg-tertiary)] disabled:opacity-40 disabled:cursor-not-allowed';

/**
 * One webhook as a card: status line, the URL with Copy, then Copy as cURL ·
 * Renew secret · Revoke, and the secret while it is still in memory (right
 * after Create or Renew). Exported so the trigger-node panel renders
 * identical rows.
 */
export function WebhookRow({ row, ctl }) {
    const { t } = useTranslation();
    const url = webhookUrl(row);
    const secret = ctl.revealedSecrets[row.id];
    const hasSecret = !!secret;
    const revealed = ctl.visibleSecretIds[row.id];

    return (
        <li className="rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)] p-3 flex flex-col gap-2 text-[12px]">
            <div className="flex items-center gap-2 flex-wrap">
                <Webhook size={14} className="text-[var(--type-trigger)]" />
                <span className="font-semibold text-[var(--text-primary)]">{row.name || t('routines.settings.webhook', 'Webhook')}</span>
                {hasSecret && (
                    <span className="px-1.5 rounded-full text-[11px] bg-[color-mix(in_srgb,var(--success)_14%,transparent)] text-[var(--success)]">
                        {t('routines.settings.webhook_new', 'new · copy now')}
                    </span>
                )}
                <span className="ml-auto text-[var(--text-tertiary)]">
                    {row.lastSeenAt
                        ? t('routines.settings.webhook_last_used', 'last used {when}', { when: new Date(row.lastSeenAt).toLocaleString() })
                        : t('routines.settings.webhook_never_used', 'never used')}
                </span>
            </div>
            <div className="flex items-center gap-2">
                <code className="flex-1 min-w-0 truncate px-2 py-1.5 rounded-md bg-[var(--bg-secondary)] font-mono text-[11px] text-[var(--text-primary)]" title={url}>
                    {url}
                </code>
                <button
                    type="button"
                    onClick={() => ctl.copyUrl(row)}
                    aria-label={t('routines.settings.webhook_copy_url', 'Copy webhook URL')}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-[var(--border-default)] hover:bg-[var(--bg-tertiary)] text-[var(--text-primary)]"
                >
                    {ctl.copied === row.id ? <Check size={12} /> : <Copy size={12} />}
                    {t('routines.settings.webhook_copy', 'Copy')}
                </button>
            </div>
            <div className="flex items-center gap-1 flex-wrap text-[var(--text-secondary)]">
                <button
                    type="button"
                    onClick={() => ctl.copyCurl(row)}
                    disabled={!hasSecret}
                    title={/* nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret -- an i18n key / label that names the secret, not a secret */ hasSecret ? undefined : t('routines.settings.webhook_curl_needs_secret', 'Renew the secret first: it is only shown once')}
                    className={ROW_ACTION}
                >
                    {ctl.copied === `curl-${row.id}` ? t('routines.settings.webhook_copied', 'Copied') : t('routines.settings.webhook_copy_curl', 'Copy as cURL')}
                </button>
                <button type="button" onClick={() => ctl.rotate(row)} className={ROW_ACTION}>
                    {t('routines.settings.webhook_renew', 'Renew secret')}
                </button>
                <button type="button" onClick={() => ctl.remove(row)} className={`${ROW_ACTION} text-[var(--error)]`}>
                    {t('routines.settings.webhook_revoke', 'Revoke')}
                </button>
            </div>
            {secret && (
                <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                        <code className="flex-1 min-w-0 truncate px-2 py-1 rounded-md bg-[var(--bg-secondary)] font-mono text-[11px] text-[var(--text-primary)]">
                            {revealed ? secret : maskSecret(secret)}
                        </code>
                        <button
                            type="button"
                            onClick={() => ctl.toggleReveal(row.id)}
                            aria-label={/* nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret -- an i18n key / label that names the secret, not a secret */ revealed ? t('routines.settings.webhook_hide_secret', 'Hide secret') : t('routines.settings.webhook_show_secret', 'Show secret')}
                            className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-tertiary)]"
                        >
                            {revealed ? <EyeOff size={14} /> : <Eye size={14} />}
                        </button>
                        <button
                            type="button"
                            onClick={() => ctl.copySecret(row.id, secret)}
                            aria-label={/* nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret -- an i18n key / label that names the secret, not a secret */ t('routines.settings.webhook_copy_secret', 'Copy secret')}
                            className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-tertiary)]"
                        >
                            {ctl.copied === `secret-${row.id}` ? <Check size={14} /> : <Copy size={14} />}
                        </button>
                    </div>
                    <div className="text-[var(--text-tertiary)]">
                        {/* nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret -- an i18n key that names the secret, not a secret */}
                        {t('routines.settings.webhook_secret_once', 'You only see the secret now. Requests without a valid signature are refused.')}
                    </div>
                </div>
            )}
        </li>
    );
}
