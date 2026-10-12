/**
 * The dead ends of a journey, each said plainly. "Not available" covers a
 * wrong link, a closed form AND a form not shared with this person: the
 * token is the credential, so the server answers all three alike and so does
 * this screen.
 */

import React from 'react';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import type { FillStatus } from '@/features/forms/model/fillSession';
import { EmptyState, type IconName } from '@/shared/ui';


type Dead = Extract<FillStatus, 'missing' | 'expired' | 'offline' | 'error' | 'slow'>;

function words(t: TranslateFn, status: Dead): { icon: IconName; title: string; message: string } {
    switch (status) {
        case 'missing':
            return {
                icon: 'Unlink',
                title: t('forms.public_missing_title', 'This form is not available'),
                message: t('mobile.forms.fill.missing_body', 'The link may have expired, the form may have been taken offline, or it was not shared with you.'),
            };
        case 'expired':
            return {
                icon: 'Timer',
                title: t('forms.public_expired_title', 'This form has expired'),
                message: t('mobile.forms.fill.expired_body', 'It was left open too long. Open it again to start over.'),
            };
        case 'offline':
            return {
                icon: 'CircleAlert',
                title: t('forms.public_offline_title', 'Could not reach the server'),
                message: t('mobile.forms.fill.offline_body', 'Check your connection and try again.'),
            };
        case 'slow':
            return {
                icon: 'History',
                title: t('forms.public_slow_title', 'This is taking a while'),
                message: t('mobile.forms.fill.slow_body', 'Your answers were received — the automation is still working on them.'),
            };
        default:
            return {
                icon: 'CircleAlert',
                title: t('forms.public_error_title', 'Something went wrong'),
                message: t('mobile.forms.fill.error_body', 'This form could not be finished. Please try again later.'),
            };
    }
}

export function FillMessage({ status, onRetry }: { status: Dead; onRetry?: () => void }) {
    const t = useTranslation();
    const said = words(t, status);
    const retry = status === 'slow' ? t('forms.public_check_again', 'Check again') : t('forms.studio.retry', 'Try again');
    return (
        <EmptyState
            icon={said.icon}
            title={said.title}
            message={said.message}
            actionLabel={onRetry ? retry : undefined}
            onAction={onRetry}
            actionVariant="secondary"
        />
    );
}
