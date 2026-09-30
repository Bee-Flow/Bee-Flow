/**
 * What every outline row needs from the screen, handed down once instead of
 * through each cell's props — so the FlatList's renderItem can live outside
 * the render function (ARCHITECTURE.md, "Performance").
 */

import { createContext, useContext } from 'react';

import type { FlowDefinition } from '@/features/flow-editor/model';
import type { AddTarget } from '@/features/flow-editor/model/outline';

import type { CardContext } from './cardModel';

export interface OutlineHandlers {
    definition: FlowDefinition;
    card: CardContext;
    /** Edits are paused (the AI is building). */
    locked: boolean;
    onOpen: (address: string) => void;
    onMenu: (address: string) => void;
    onAdd: (target: AddTarget) => void;
    onToggleGroup: (key: string) => void;
    onJump: (nodeId: string) => void;
}

export const OutlineContext = createContext<OutlineHandlers | null>(null);

export function useOutline(): OutlineHandlers {
    const value = useContext(OutlineContext);
    if (!value) throw new Error('An outline row must render inside <StepOutline>');
    return value;
}
