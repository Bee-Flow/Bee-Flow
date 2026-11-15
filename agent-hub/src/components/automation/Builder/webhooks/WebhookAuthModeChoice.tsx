import { TriangleAlert } from 'lucide-react';
import useTranslation from '@/hooks/useTranslation';
import { SELECT } from '../settings/settingsUi';
import type { WebhookAuthMode } from './useWebhooks';

interface Props {
    value: WebhookAuthMode;
    onChange: (mode: WebhookAuthMode) => void;
    disabled?: boolean;
}

/**
 * How the caller of a NEW webhook proves itself: by signing every request
 * (the default, and what we recommend), or with a fixed token in a header,
 * for a system that cannot sign. Choosing the token shows why it is weaker;
 * the choice is fixed per webhook once it is created.
 */
export default function WebhookAuthModeChoice({ value, onChange, disabled = false }: Props) {
    const { t } = useTranslation();
    return (
        <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 flex-wrap text-[var(--text-secondary)]">
                <span>{t('automation_webhook_log.auth.label', 'Callers prove themselves by')}</span>
                <select
                    className={SELECT}
                    value={value}
                    disabled={disabled}
                    onChange={(e) => onChange(e.target.value === 'header_token' ? 'header_token' : 'hmac')}
                >
                    <option value="hmac">{t('automation_webhook_log.auth.hmac', 'Signing each request (recommended)')}</option>
                    <option value="header_token">{t('automation_webhook_log.auth.header_token', 'A token in a header')}</option>
                </select>
            </label>
            {value === 'header_token' && (
                <div role="note" data-testid="webhook-header-token-warning" className="flex items-start gap-1.5 rounded-md px-2 py-1.5 bg-[color-mix(in_srgb,var(--warning)_12%,transparent)] text-[var(--text-primary)]">
                    <TriangleAlert size={13} className="mt-0.5 shrink-0 text-[var(--warning)]" />
                    <span>{t('automation_webhook_log.auth.warning', 'A header token is weaker than signing: anyone who sees the token can send requests, and a captured request can be sent again. Use it only for a system that cannot sign, and send it as Authorization: Bearer, never in the address.')}</span>
                </div>
            )}
        </div>
    );
}
