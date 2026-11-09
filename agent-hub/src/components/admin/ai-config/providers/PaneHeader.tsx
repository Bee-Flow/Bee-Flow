import type { ReactNode } from 'react';
import { CHIP, CHIP_SUCCESS } from '@/components/mcpLibrary/ui';
import { useTranslation } from '@/hooks/useTranslation';

interface PaneHeaderProps {
    icon: string;
    iconClass: string;
    title: string;
    connected: boolean;
    /** Replaces the "Connected" chip text (a runtime reads "Self-hosted"). */
    statusLabel?: string;
    description?: string;
    docsUrl?: string;
    docsLabel?: string;
    children?: ReactNode;
}

/** Icon, name, status chip, one-line description and docs link of a provider pane. */
export default function PaneHeader({ icon, iconClass, title, connected, statusLabel, description, docsUrl, docsLabel, children }: PaneHeaderProps) {
    const { t } = useTranslation();
    return (
        <header className="flex items-start gap-3">
            <div aria-hidden="true" className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-xl ${iconClass}`}>
                {icon}
            </div>
            <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                    <h2 className="m-0 text-base font-semibold text-[var(--text-primary)]">{title}</h2>
                    <span className={connected ? CHIP_SUCCESS : CHIP}>
                        {statusLabel ?? (connected ? t('admin_ai_config.status_connected', 'Connected') : t('admin_ai_config.status_not_connected', 'Not connected'))}
                    </span>
                </div>
                {description ? <p className="m-0 mt-1 text-xs text-[var(--text-secondary)]">{description}</p> : null}
                {docsUrl ? (
                    <p className="m-0 mt-1 text-xs text-[var(--text-tertiary)]">
                        {t('admin_ai_config.apikey_get_from')}{' '}
                        <a href={docsUrl} target="_blank" rel="noopener noreferrer" className="underline hover:text-[var(--accent-primary)]">{docsLabel || docsUrl}</a>
                    </p>
                ) : null}
            </div>
            {children}
        </header>
    );
}
