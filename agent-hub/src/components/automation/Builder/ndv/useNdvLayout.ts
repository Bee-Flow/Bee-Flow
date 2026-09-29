import type { NdvPanels } from '../useNdvPanels';
import { columnLayout, toggleSide, type ColumnLayout, type NdvSide } from './ndvLayout';
import useElementWidth from './useElementWidth';

/** Below this drawer width the quick drawer stacks its output under the settings. */
export const QUICK_SIDE_BY_SIDE = 1100;

/**
 * The drawer's column plumbing on top of useNdvPanels: which side columns
 * fit (by the drawer's own width), what their header toggles do, and the
 * props for each NdvSideColumn.
 */
export default function useNdvLayout({ panels, quick, goFull }: {
    panels: NdvPanels;
    quick: boolean;
    goFull: () => void;
}) {
    const { inputOpen, outputOpen, narrowSide, setInputOpen, setOutputOpen, setNarrowSide } = panels;
    const [drawerRef, drawerWidth] = useElementWidth<HTMLDivElement>();
    const layout: ColumnLayout = columnLayout({ ...panels, width: drawerWidth });

    const onSide = (side: NdvSide) => {
        // At quick density a side column grows the drawer to the full view with it open.
        if (quick) {
            if (side === 'input') setInputOpen(true); else setOutputOpen(true);
            setNarrowSide(side);
            goFull();
            return;
        }
        const next = toggleSide(side, { inputOpen, outputOpen, narrowSide }, layout);
        setInputOpen(next.inputOpen);
        setOutputOpen(next.outputOpen);
        setNarrowSide(next.narrowSide);
    };

    const sideProps = (side: NdvSide) => {
        const width = side === 'input' ? layout.inputPx : layout.outputPx;
        return {
            side,
            width,
            onResizeDown: panels.onColResizeDown(side, width),
            onResizeMove: panels.onColResizeMove,
            onResizeUp: panels.onColResizeUp,
            onReset: () => panels.resetColumn(side),
        };
    };

    // A test's answer lands in Continues on: where only one side column fits,
    // that is the one to show once Test step is pressed.
    const showOutputForTest = () => { if (outputOpen) setNarrowSide('output'); };

    // Stacked, the quick drawer needs the height for the settings AND the output.
    const quickStacked = quick && panels.quickOutputOpen && drawerWidth > 0 && drawerWidth < QUICK_SIDE_BY_SIDE;
    return { drawerRef, layout, onSide, sideProps, showOutputForTest, quickStacked };
}
