import { ArrowLeft, ArrowRight, Copy } from 'lucide-react';
import ScreenMenuItem from './ScreenMenuItem';
import useTranslation from '@/hooks/useTranslation';
import { MAX_SCREENS, duplicateScreen, moveScreen } from '../state/structureOps';
import type { AppDefinition, AppScreen } from '../inspector/appDefinition';
import type { AppEditorAction } from '../state/appEditorState';

interface ScreenOrderMenuItemsProps {
    screen: AppScreen;
    definition: AppDefinition;
    onCommit: ((def: AppDefinition) => void) | undefined;
    dispatch: (action: AppEditorAction) => void;
    /** Closes the menu. */
    onDone: () => void;
}

/**
 * The screen tab menu's entries for order and copying: duplicate (a copy right after it, opened
 * on the canvas), move left and move right. The keyboard route beside dragging a tab
 * (screenOrder.ts); both run the shared moveScreen op.
 */
export default function ScreenOrderMenuItems({ screen, definition, onCommit, dispatch, onDone }: ScreenOrderMenuItemsProps) {
    const { t } = useTranslation();
    const screens = definition.screens || [];
    const index = screens.findIndex((s) => s.id === screen.id);
    const full = screens.length >= MAX_SCREENS;
    const move = (to: number) => {
        onDone();
        const next = moveScreen(definition, screen.id, to);
        if (next !== definition) onCommit?.(next);
    };
    const duplicate = () => {
        onDone();
        const { def, screenId } = duplicateScreen(definition, screen.id, {
            name: t('studio_apps_sections.screens.copy_name', '{name} copy', { name: screen.name || '' }).trim(),
        });
        if (!screenId) return;
        onCommit?.(def);
        dispatch({ type: 'set_screen', screenId });
    };
    return (
        <>
            <ScreenMenuItem
                icon={Copy}
                label={t('studio_apps_sections.screens.duplicate', 'Duplicate screen')}
                disabled={full}
                title={full ? t('studio_apps_sections.screens.max', 'An app holds at most {n} screens.', { n: MAX_SCREENS }) : undefined}
                onClick={duplicate}
            />
            <ScreenMenuItem icon={ArrowLeft} label={t('studio_apps_sections.screens.move_left', 'Move left')} disabled={index <= 0} onClick={() => move(index - 1)} />
            <ScreenMenuItem icon={ArrowRight} label={t('studio_apps_sections.screens.move_right', 'Move right')} disabled={index === -1 || index >= screens.length - 1} onClick={() => move(index + 1)} />
        </>
    );
}
