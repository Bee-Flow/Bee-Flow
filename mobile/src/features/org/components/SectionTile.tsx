/**
 * A section's glyph in its web accent, on a 15% tint of it (the web's
 * OrgSubItem) — or a warning triangle when the row needs the admin's
 * attention (a licence about to run out).
 */

import React from 'react';

import { useTheme } from '@/core/theme/ThemeProvider';
import { IconTile, kindColor, tonePair } from '@/shared/ui';

import type { OrgSection } from '../model/sections';

export function SectionTile({ section, warning = false }: { section: OrgSection; warning?: boolean }) {
    const theme = useTheme();
    if (warning) return <IconTile name="TriangleAlert" color={tonePair(theme.colors, 'warning').raw} />;
    const color = section.color === 'compliance' ? kindColor(theme, 'compliance') : section.color;
    return <IconTile name={section.icon} color={color} />;
}
