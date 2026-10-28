/**
 * A failed read, sized to its section. A licence answer (403) is information
 * rather than an error, and gets no Retry that can never succeed.
 */

import React from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { Banner, Button } from '@/shared/ui';

export function ProblemBanner({ error, onRetry }: { error: unknown; onRetry: () => void }) {
    const t = useTranslation();
    const described = describeError(error);
    return (
        <Banner
            tone={described.retryable ? 'error' : 'info'}
            action={described.retryable ? <Button label={t('chat.retry', 'Retry')} variant="ghost" onPress={onRetry} /> : undefined}
        >
            {described.message}
        </Banner>
    );
}
