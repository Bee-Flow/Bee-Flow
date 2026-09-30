/**
 * A caution in a step editor: a warning (or error, or info) banner.
 */

import React, { type ReactNode } from 'react';

import { Banner } from '@/shared/ui';

export function Warn({ children, tone = 'warning' }: { children: ReactNode; tone?: 'warning' | 'error' | 'info' }) {
    return <Banner tone={tone}>{children}</Banner>;
}
