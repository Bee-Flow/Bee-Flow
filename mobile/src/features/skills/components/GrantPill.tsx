/**
 * One thing a skill reaches — a step's reference or a "may use" grant — as a
 * pill in its kind's colour. Tapping it offers what can be done with it
 * (open it, remove it); a pill with nothing to offer is plain text, never a
 * control that swallows the tap.
 */

import React, { useState } from 'react';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { ActionMenu, Chip, Icon, kindColor, kindOf, type ActionMenuItem, type IconName } from '@/shared/ui';

export function GrantPill({
    label,
    icon,
    kind,
    onOpen,
    onRemove,
    removeLabel,
}: {
    label: string;
    icon: IconName;
    /** The kinds.ts key that colours the glyph ('kb', 'automation', 'datatable', 'app'). */
    kind: string;
    onOpen?: () => void;
    onRemove?: () => void;
    removeLabel: string;
}) {
    const t = useTranslation();
    const theme = useTheme();
    const [open, setOpen] = useState(false);
    const items: ActionMenuItem[] = [];
    if (onOpen) items.push({ id: 'open', label: t('mobile.skills.open', 'Open'), icon: 'ExternalLink', onPress: onOpen });
    if (onRemove) items.push({ id: 'remove', label: removeLabel, icon: 'X', destructive: true, onPress: onRemove });
    const press = items.length === 0 ? undefined : items.length === 1 && onOpen ? onOpen : () => setOpen(true);
    return (
        <>
            <Chip
                label={label}
                icon={<Icon name={icon} size={14} color={kindColor(theme, kindOf(kind))} />}
                onPress={press}
                accessibilityHint={onRemove ? removeLabel : undefined}
            />
            {items.length > 1 || (items.length === 1 && onRemove) ? (
                <ActionMenu visible={open} onClose={() => setOpen(false)} title={label} items={items} />
            ) : null}
        </>
    );
}
