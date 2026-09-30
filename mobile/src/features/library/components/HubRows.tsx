/**
 * The first few rows of a hub section, divided. Bounded by PREVIEW_ROWS, so a
 * map rather than a list: "See all" is where the rest lives.
 */

import React, { type ReactNode } from 'react';

import { useTheme } from '@/core/theme/ThemeProvider';
import { Divider } from '@/shared/ui';

/** How many rows a hub section shows before "See all" earns its place. */
export const PREVIEW_ROWS = 4;

export function HubRows<T extends { id: string }>({
    items,
    renderRow,
}: {
    items: readonly T[];
    renderRow: (item: T) => ReactNode;
}) {
    const theme = useTheme();
    return (
        <>
            {items.slice(0, PREVIEW_ROWS).map((item, i) => (
                <React.Fragment key={item.id}>
                    {i > 0 ? <Divider inset={theme.spacing.lg} /> : null}
                    {renderRow(item)}
                </React.Fragment>
            ))}
        </>
    );
}
