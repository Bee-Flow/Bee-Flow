/**
 * A card's menu (long-press or ⋯): the web card's action chrome — run up to
 * here, duplicate, disconnect, pin, delete — plus open, test this step and
 * the outline's move up/down, as the kit's ActionMenu sheet. Which actions
 * show, and whether they can run now, is actions.ts; the words and glyphs
 * are here. The hints are the web buttons' tooltips.
 */

import React from 'react';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import type { StepAction, StepActionId } from '@/features/flow-editor/model/outline';
import { ActionMenu, type ActionMenuItem, type IconName } from '@/shared/ui';


interface Words {
    icon: IconName;
    label: (t: TranslateFn) => string;
    hint?: (t: TranslateFn) => string;
    destructive?: boolean;
}

const WORDS: Record<StepActionId, Words> = {
    open: { icon: 'SquarePen', label: (t) => t('mobile.flow.action.open', 'Open') },
    addTrigger: {
        icon: 'Plus',
        label: (t) => t('mobile.flow.action.add_trigger', 'Add another trigger'),
        hint: (t) => t('mobile.flow.action.add_trigger_hint', 'Another way for this routine to start'),
    },
    openFlowlet: { icon: 'Layers', label: (t) => t('mobile.flow.action.open_flowlet', 'Open flowlet') },
    test: {
        icon: 'Play',
        label: (t) => t('mobile.flow.action.test', 'Test this step'),
        hint: (t) => t('mobile.flow.action.test_hint', 'Runs only this step, on the data it last received'),
    },
    runUpTo: {
        icon: 'FastForward',
        label: (t) => t('mobile.flow.action.run_up_to', 'Run up to here'),
        hint: (t) => t('mobile.flow.action.run_up_to_hint', 'Runs the flow up to this step; pinned steps reuse their data'),
    },
    runFrom: {
        icon: 'CornerDownRight',
        label: (t) => t('mobile.flow.action.run_from', 'Run from here'),
        hint: (t) => t('mobile.flow.action.run_from_hint', 'Runs this step and everything after it, on the data the steps before it last produced'),
    },
    duplicate: {
        icon: 'Copy',
        label: (t) => t('routines.ndv.duplicate', 'Duplicate'),
        hint: (t) => t('mobile.flow.action.duplicate_hint', 'Copies this step and its settings'),
    },
    moveUp: { icon: 'ArrowUp', label: (t) => t('mobile.flow.action.move_up', 'Move up') },
    moveDown: { icon: 'ArrowDown', label: (t) => t('mobile.flow.action.move_down', 'Move down') },
    pin: {
        icon: 'Pin',
        label: (t) => t('mobile.flow.action.pin', 'Pin output'),
        hint: (t) => t('mobile.flow.action.pin_hint', 'Freezes the last output so later runs reuse it'),
    },
    unpin: {
        icon: 'PinOff',
        label: (t) => t('mobile.flow.action.unpin', 'Unpin output'),
        hint: (t) => t('mobile.flow.action.unpin_hint', 'Releases the frozen output'),
    },
    disable: {
        icon: 'Power',
        label: (t) => t('routines.ndv.disable', 'Disable'),
        hint: (t) => t('routines.ndv.disable_title', 'Disable this node (skipped during execution)'),
    },
    enable: {
        icon: 'Power',
        label: (t) => t('mobile.flow.action.enable', 'Enable'),
        hint: (t) => t('routines.ndv.reenable_title', 'Re-enable this node'),
    },
    detach: {
        icon: 'Unlink',
        label: (t) => t('mobile.flow.action.detach', 'Disconnect'),
        hint: (t) => t('mobile.flow.action.detach_hint', 'Takes this step out of the flow; its neighbours reconnect'),
    },
    delete: {
        icon: 'Trash2',
        label: (t) => t('common.delete', 'Delete'),
        hint: (t) => t('mobile.flow.action.delete_hint', 'Removes this step and reconnects its neighbours'),
        destructive: true,
    },
};

export function StepActionsMenu({
    title,
    actions,
    onClose,
    onAction,
}: {
    /** The step's name; the menu is open while this is non-null. */
    title: string | null;
    actions: readonly StepAction[];
    onClose: () => void;
    onAction: (id: StepActionId) => void;
}) {
    const t = useTranslation();
    const items: ActionMenuItem[] = actions.map((a) => {
        const words = WORDS[a.id];
        return {
            id: a.id,
            label: words.label(t),
            icon: words.icon,
            disabled: !a.enabled,
            destructive: words.destructive,
            accessibilityHint: words.hint?.(t),
            onPress: () => onAction(a.id),
        };
    });
    return <ActionMenu visible={title !== null} onClose={onClose} title={title ?? undefined} items={items} testID="step-actions" />;
}
