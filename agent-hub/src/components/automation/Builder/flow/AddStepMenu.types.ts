import type { PaletteScope, SearchCandidate, StepGroup } from './stepPalette.types';
import type { StepPayload } from './ribbon/ribbonCategories';

/** The scope the menu is built for: the palette's own, plus the smart-row lists the host computed. */
type AddStepScope = PaletteScope & { suggested?: SearchCandidate[] | null; frequent?: SearchCandidate[] | null };

export interface RecoGroup {
    key: string;
    title: string;
    accent: boolean;
    items: SearchCandidate[];
}

export type AddFn = (payload: StepPayload) => void;

export interface AddStepMenuProps {
    /** { catalog, layers, inLayer, canAddLayerOutput, isBlockRoot, mode } */
    scope?: AddStepScope;
    /** A single group descriptor from buildStepGroups (ribbon dropdown). Omit to render the FULL menu (all groups, used by the popover). */
    group?: StepGroup | null;
    /** Show the search box (default: true when no single `group`). */
    showSearch?: boolean;
    /** Insert the step. */
    onAdd?: AddFn;
    /** Called after a click-add so the caller can close. */
    onAfterAdd?: () => void;
    /** Focus the search box on mount. */
    autoFocus?: boolean;
}
