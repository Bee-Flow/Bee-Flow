// The refusals of the admin dashboard, on the shared EmptyState:
//   whole   no admin tab at all for this user (the page has no rail then);
//   section the tab in the URL is not one this user may open;
//   no-plan the organisation's licence page, where the subscription gate sends
//           everyone of a cloud organisation without a plan, for someone who
//           cannot choose one: it says whom to ask instead of refusing.

import { Ban, CreditCard, Lock } from 'lucide-react';
import React from 'react';
import EmptyState from '@/components/shared/EmptyState';
import { PRIMARY_BTN } from '@/components/mcpLibrary/ui';
import { useTranslation } from '@/hooks/useTranslation';

interface AdminAccessDeniedProps {
    /** 'whole': the dashboard; 'section': one tab of it; 'no-plan': the licence page of an organisation without a plan. */
    scope: 'whole' | 'section' | 'no-plan';
    onBack?: React.MouseEventHandler<HTMLButtonElement>;
    /** 'no-plan' inside the dashboard's chrome (the rail drawn beside it). */
    inSection?: boolean;
}

/** The licence page of an organisation without a plan, for a member who cannot choose one. */
function NoPlan({ inSection }: { inSection: boolean }) {
    const { t } = useTranslation();
    return (
        <div className={inSection ? 'absolute inset-0' : 'h-full bg-[var(--bg-primary)]'} data-testid="admin-access-denied-no-plan">
            <EmptyState
                icon={(
                    <span className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--bg-secondary)] text-[var(--text-secondary)]">
                        <CreditCard className="h-7 w-7" strokeWidth={2} />
                    </span>
                )}
                title={<h2 className="m-0 text-lg font-semibold">{t('admin.no_plan_title', 'No plan yet')}</h2>}
                description={t('admin.no_plan_desc', 'Your organisation does not have an active plan yet. Ask an administrator of your organisation to choose one.')}
            />
        </div>
    );
}

export default function AdminAccessDenied({ scope, onBack, inSection = false }: AdminAccessDeniedProps) {
    const { t } = useTranslation();
    if (scope === 'no-plan') return <NoPlan inSection={inSection} />;
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
