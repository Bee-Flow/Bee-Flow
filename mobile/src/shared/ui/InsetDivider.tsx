/**
 * A Divider inset to line up with row text: the separator every list of rows
 * draws. Takes no props so a FlatList can use it as ItemSeparatorComponent
 * directly; an inline separator would be a new component type on every render.
 */

import React from 'react';

import { useTheme } from '@/core/theme/ThemeProvider';

import { Divider } from './Divider';

export function InsetDivider() {
    const theme = useTheme();
    return <Divider inset={theme.spacing.lg} />;
}
