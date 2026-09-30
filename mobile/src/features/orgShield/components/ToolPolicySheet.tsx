/**
 * What a tool may not carry out: one sheet per tool class. Edits go straight
 * into the screen's draft — the Save bar saves them with everything else.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { Banner, Button, Sheet } from '@/shared/ui';

import { CategoryToggles } from './CategoryToggles';
import { toggleId } from '../model/fields';
import type { ToolClass } from '../model/types';

export function ToolPolicySheet({
    cls,
    selected,
    lockedHint,
    onChange,
    onClose,
}: {
    cls: ToolClass | null;
    selected: readonly string[];
    /** Set when the class is licence-locked (external tools need web_search_guard). */
    lockedHint: string | null;
    onChange: (cls: ToolClass, ids: string[]) => void;
    onClose: () => void;
}) {
    const t = useTranslation();
    const title =
        cls === 'external'
            ? t('admin.shield_matrix_col_external', 'Outside tools')
            : t('admin.shield_matrix_col_internal', 'Own server');
    return (
        <Sheet
            visible={cls !== null}
            onClose={onClose}
            title={title}
            subtitle={t('mobile.orgShield.tool_sheet_subtitle', 'Kinds of data a tool may not carry out')}
            tall
            footer={<Button label={t('common.close', 'Close')} onPress={onClose} fullWidth />}
        >
            {lockedHint ? <Banner tone="info" icon="Lock">{lockedHint}</Banner> : null}
            {cls ? (
                <CategoryToggles
                    selected={selected}
                    disabled={Boolean(lockedHint)}
                    onToggle={(id, on) => onChange(cls, toggleId(selected, id, on))}
                    testPrefix={`tool-${cls}`}
                />
            ) : null}
        </Sheet>
    );
}
