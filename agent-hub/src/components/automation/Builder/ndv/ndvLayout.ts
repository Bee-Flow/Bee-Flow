/**
 * How the full step drawer shares its OWN width between its three columns:
 * 1 Comes in · 2 What this step does · 3 Continues on.
 *
 * Measured on the drawer, never the viewport: the drawer is narrower than the
 * window whenever the chat panel is open.
 *
 *   Narrow (settings would get less than SETTINGS_MIN with both side columns
 *   open): one side column at a time, the one last asked for. Showing less
 *   beats squeezing three columns into a laptop.
 *   Wide (room beyond SETTINGS_TARGET): the room is shared 1 : 1 : 2 between
 *   Comes in, the settings and Continues on, with Comes in stopping at
 *   INPUT_GROW_MAX (a field tree wider than that only moves its values away
 *   from their names) and the settings at SETTINGS_MAX (a text field 2,000px
 *   wide is harder to read, not easier). Continues on takes what is left:
 *   its table can use it. A column the user dragged keeps exactly that width.
 */

export type NdvSide = 'input' | 'output';
/** Which side column the narrow drawer shows when both are open; 'none' = neither. */
export type NdvNarrowSide = NdvSide | 'none';

/** A side column is never narrower than this (drag or layout). */
export const COL_MIN = 220;
/** …nor wider than this when dragged. */
export const COL_MAX = 1600;
/** The settings column's floor while a side column is open. */
export const SETTINGS_MIN = 640;
/** Up to this the settings column takes all the room; past it the room is shared. */
export const SETTINGS_TARGET = 880;
/** The settings column's widest while a growing side column can take the room. */
export const SETTINGS_MAX = 1040;
/** Comes in grows with a wide drawer up to this. */
export const INPUT_GROW_MAX = 640;
/** The round-4 defaults (artboard 4a). */
export const INPUT_DEFAULT = 400;
export const OUTPUT_DEFAULT = 460;

export interface ColumnLayoutInput {
    /** The drawer's width in px; 0 while not measured (and always in jsdom). */
    width: number;
    inputOpen: boolean;
    outputOpen: boolean;
    narrowSide: NdvNarrowSide;
    inputW: number;
    outputW: number;
    /** True once the user dragged that column: it then keeps its width. */
    inputSized: boolean;
    outputSized: boolean;
}

export interface ColumnLayout {
    showInput: boolean;
    showOutput: boolean;
    inputPx: number;
    outputPx: number;
    /** Both columns are open but only one fits: the toggles act as a choice. */
    oneSide: boolean;
}

export function columnLayout(p: ColumnLayoutInput): ColumnLayout {
    const width = Number.isFinite(p.width) ? p.width : 0;
    // Not measured yet: exactly what the user asked for, at the stored widths.
    if (width <= 0) {
        return { showInput: p.inputOpen, showOutput: p.outputOpen, inputPx: p.inputW, outputPx: p.outputW, oneSide: false };
    }
    const oneSide = p.inputOpen && p.outputOpen && width - p.inputW - p.outputW < SETTINGS_MIN;
    const showInput = p.inputOpen && (!oneSide || p.narrowSide === 'input');
    const showOutput = p.outputOpen && (!oneSide || p.narrowSide === 'output');
    const fitted = fitLoneColumn(width, showInput ? p.inputW : 0, showOutput ? p.outputW : 0);
    const [inputPx, outputPx] = growIntoSpare(width, fitted, [showInput && !p.inputSized, showOutput && !p.outputSized]);
    return { showInput, showOutput, inputPx, outputPx, oneSide };
}

/**
 * A lone side column never pushes the settings under their floor, unless the
 * drawer is too narrow for both floors; then the settings give way.
 */
function fitLoneColumn(width: number, inputPx: number, outputPx: number): [number, number] {
    if ((inputPx > 0) === (outputPx > 0)) return [inputPx, outputPx];
    const room = Math.max(COL_MIN, width - SETTINGS_MIN);
    return [Math.min(inputPx, room), Math.min(outputPx, room)];
}

/**
 * Room past the settings' target, shared 1 : 1 : 2 with the side columns
 * that are not held at a dragged width. The settings column is the flex
 * remainder, so what is not handed to a side column stays with it: without
 * a growing Continues on, the settings keep the rest (their form is centred
 * at a readable measure, SettingsForm).
 */
function growIntoSpare(width: number, [inputPx, outputPx]: [number, number], [growIn, growOut]: [boolean, boolean]): [number, number] {
    const spare = width - inputPx - outputPx - SETTINGS_TARGET;
    if (spare <= 0 || !(growIn || growOut)) return [inputPx, outputPx];
    const unit = spare / ((growIn ? 1 : 0) + 1 + (growOut ? 2 : 0));
    const addIn = growIn ? Math.max(0, Math.min(unit, INPUT_GROW_MAX - inputPx)) : 0;
    const addSettings = Math.min(unit, SETTINGS_MAX - SETTINGS_TARGET);
    const addOut = growOut ? spare - addIn - addSettings : 0;
    return [inputPx + Math.floor(addIn), outputPx + Math.floor(addOut)];
}

/**
 * What a click on a side column's toggle does, given what is on screen.
 * Returns the new open flags and narrow choice; the caller stores them.
 *
 *   Shown  -> hide it. In the one-at-a-time mode the other stays open for
 *            the wide drawer but is not revealed: hiding one column must not
 *            make a different one appear.
 *   Hidden -> show it, and make it the narrow drawer's choice.
 */
export function toggleSide(
    side: NdvSide,
    state: { inputOpen: boolean; outputOpen: boolean; narrowSide: NdvNarrowSide },
    layout: Pick<ColumnLayout, 'showInput' | 'showOutput' | 'oneSide'>,
): { inputOpen: boolean; outputOpen: boolean; narrowSide: NdvNarrowSide } {
    const shown = side === 'input' ? layout.showInput : layout.showOutput;
    if (shown) {
        if (layout.oneSide) return { ...state, narrowSide: 'none' };
        return side === 'input' ? { ...state, inputOpen: false } : { ...state, outputOpen: false };
    }
    return side === 'input'
        ? { ...state, inputOpen: true, narrowSide: 'input' }
        : { ...state, outputOpen: true, narrowSide: 'output' };
}
