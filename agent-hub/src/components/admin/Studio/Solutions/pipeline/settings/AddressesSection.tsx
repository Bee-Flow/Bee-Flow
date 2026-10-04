import { Check, Copy } from 'lucide-react';
import React, { useState } from 'react';
import { useTranslation } from '../../../../../../hooks/useTranslation';

/**
 * The addresses that reach this stage from outside (design 3.3): the pages it
 * serves and the webhooks of its automations, each with a copy button.
 *
 * A webhook address is a credential, so the server lists webhooks for the stage
 * owner only. For anyone else the section says that, rather than printing "no
 * webhooks": an editor who sees a list without them must not conclude there are
 * none.
 */

export interface AddressesSectionProps {
    inbound: Array<{ kind: string; label: string; url: string }>;
    isOwner: boolean;
}

function CopyButton({ value }: { value: string }) {
    const { t } = useTranslation();
    const [copied, setCopied] = useState(false);
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch { /* the address is on screen; copying by hand still works */ }
    };
    return (
        <button type="button" onClick={copy} aria-label={t('stage_settings.copy_address', 'Copy address')} className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)]">
            {copied ? <Check className="w-3.5 h-3.5" aria-hidden="true" /> : <Copy className="w-3.5 h-3.5" aria-hidden="true" />}
        </button>
    );
}

export default function AddressesSection({ inbound, isOwner }: AddressesSectionProps) {
    const { t } = useTranslation();
    return (
        <div className="space-y-2" data-testid="settings-addresses">
            {inbound.length === 0 ? (
                <p className="text-sm text-[var(--text-tertiary)]" data-testid="addresses-none">
                    {t('stage_settings.addresses_none', 'This stage has no address anyone can call yet.')}
                </p>
            ) : (
                <ul className="space-y-1.5">
                    {inbound.map(a => (
                        <li key={`${a.kind}:${a.url}`} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--bg-secondary)]" data-testid="address-row">
                            <span className="text-xs text-[var(--text-tertiary)] shrink-0">{a.label || a.kind}</span>
                            <code className="text-xs text-[var(--text-primary)] truncate flex-1 min-w-0">{a.url}</code>
                            <CopyButton value={a.url} />
                        </li>
                    ))}
                </ul>
            )}
            {!isOwner && (
                <p className="text-xs text-[var(--text-tertiary)]" data-testid="addresses-webhooks-hidden">
                    {t('stage_settings.addresses_webhooks_hidden', 'Webhook addresses are only shown to the owner of this Solution, because they work as a password.')}
                </p>
            )}
        </div>
    );
}
