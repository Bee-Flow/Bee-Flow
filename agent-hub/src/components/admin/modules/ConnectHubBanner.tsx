import React from 'react';
import { Loader2, Plug } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import { PRIMARY_BTN } from '@/components/mcpLibrary/ui';

interface ConnectHubBannerProps {
    licensed?: boolean;
    busy?: boolean;
    onConnect: () => void;
}

// Shown on the Marketplace tab when the install is not connected to the hub.
// The primary CTA opens the connect confirm dialog.
export default function ConnectHubBanner({ licensed = true, busy, onConnect }: ConnectHubBannerProps) {
    const { t } = useTranslation();
    return (
        <div
            className="rounded-lg border p-4 flex flex-col sm:flex-row sm:items-center gap-4 bg-[var(--bg-primary)] border-[var(--border-default)]"
            data-testid="connect-hub-banner"
        >
            <div className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
                <Plug className="w-5 h-5" aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold text-[var(--text-primary)]">{t('modules.connect_title')}</h3>
                <p className="text-xs mt-1 leading-relaxed text-[var(--text-secondary)]">
                    {licensed ? t('modules.connect_body') : t('modules.connect_body_unlicensed')}
                </p>
            </div>
            <button
                type="button"
                onClick={onConnect}
                disabled={busy}
                className={`${PRIMARY_BTN} flex-shrink-0`}
            >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plug className="w-4 h-4" />}
                {t('modules.connect_cta')}
            </button>
        </div>
    );
}
