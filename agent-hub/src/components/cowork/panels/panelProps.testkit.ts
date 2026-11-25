// The props the Cowork page gives one of its pages (../coworkSheetPanels.ts), for their tests: the page's kind, no user,
// and the three ways out as plain functions the test can replace.
import type { CoworkSheetPanel, CoworkSheetPanelProps } from '../coworkSheetPanels';

export function panelProps(panel: CoworkSheetPanel, over: Partial<CoworkSheetPanelProps> = {}): CoworkSheetPanelProps {
    return { panel, user: null, close: () => {}, open: () => {}, fillComposer: () => {}, ...over };
}
