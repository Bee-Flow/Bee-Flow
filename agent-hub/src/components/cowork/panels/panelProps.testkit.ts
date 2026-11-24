// The props the Cowork sheet gives a panel (../coworkSheetPanels.ts), for the panel tests: a panel kind, no user, and the
// three ways out as plain functions the test can replace.
import type { CoworkSheetPanel, CoworkSheetPanelProps } from '../coworkSheetPanels';

export function panelProps(panel: CoworkSheetPanel, over: Partial<CoworkSheetPanelProps> = {}): CoworkSheetPanelProps {
    return { panel, user: null, close: () => {}, open: () => {}, fillComposer: () => {}, ...over };
}
