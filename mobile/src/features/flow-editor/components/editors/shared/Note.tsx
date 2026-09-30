/**
 * A standing sentence under a step editor's field: tertiary caption text.
 */

import React, { type ReactNode } from 'react';

import { Text } from '@/shared/ui';

export function Note({ children }: { children: ReactNode }) {
    return (
        <Text variant="caption" tone="tertiary">
            {children}
        </Text>
    );
}
