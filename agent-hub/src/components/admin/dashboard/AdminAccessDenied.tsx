// The two refusals of the admin dashboard, on the shared EmptyState:
//   whole   no admin tab at all for this user (the page has no rail then);
//   section the tab in the URL is not one this user may open.

import { Ban, Lock } from 'lucide-react';
import React from 'react';
import EmptyState from '@/components/shared/EmptyState';
import { PRIMARY_BTN } from '@/components/mcpLibrary/ui';
import { useTranslation } from '@/hooks/useTranslation';

interface AdminAccessDeniedProps {
    /** 'whole': the dashboard; 'section': one tab of it. */
    scope: 'whole' | 'section';
    onBack?: React.MouseEventHandler<HTMLButtonElement>;
}

export default function AdminAccessDenied({ scope, onBack }: AdminAccessDeniedProps) {
    const { t } = useTranslation();
    const whole = scope === 'whole';
    const Icon = whole ? Ban : Lock;
    return (
        <div className={whole ? 'h-full bg-[var(--bg-primary)]' : 'absolute inset-0'} data-testid={`admin-access-denied-${scope}`}>
            <EmptyState
                icon={(
                    <span className="flex h-14 w-14 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--error)_10%,transparent)] text-[var(--error)]">
                        <Icon className="h-7 w-7" strokeWidth={2} />
                    </span>
                )}
                title={<h2 className="m-0 text-lg font-semibold">{whole ? t('admin.access_denied_title') : t('admin.forbidden_title')}</h2>}
                description={whole ? t('admin.access_denied_desc') : t('admin.forbidden_desc')}
                action={whole && onBack ? <button type="button" onClick={onBack} className={PRIMARY_BTN}>{t('admin.go_back')}</button> : undefined}
            />
        </div>
    );
}
