/**
 * Automations could not be read. A licence refusal is a normal answer, and
 * belongs next to the thing it gates rather than as a screen-wide failure; a
 * retry is offered only when one could help.
 */

import React from 'react';

import { describeError } from '@/core/api/errors';
import { Banner, Button } from '@/shared/ui';

export function AutomationsUnavailableBanner({ error, onRetry }: { error: unknown; onRetry: () => void }) {
    const described = describeError(error);
    return (
        <Banner
            tone={described.retryable ? 'error' : 'info'}
            action={described.retryable ? <Button label="Retry" variant="ghost" onPress={onRetry} /> : undefined}
        >
            {described.message}
        </Banner>
    );
}
