/** The min/max/step of one unit of an advanced-sizing knob. */
export interface UnitRange {
    min: number;
    max: number;
    step: number;
    default: number;
}

export interface IntKnob {
    type: 'int';
    min: number;
    max: number;
    step: number;
    default: number;
}

export interface EnumKnob {
    type: 'enum';
    values: (string | null)[];
    default: string | null;
}

export interface ColorKnob {
    type: 'colorOrRole';
    roles: string[];
    default: null;
}

/** A px/pct/vh value whose unit is named by a sibling `*Mode` knob. */
export interface UnitIntKnob {
    type: 'unitInt';
    modeKnob: string;
    default: null;
    units: Record<string, UnitRange>;
}

export type StyleKnobSpec = IntKnob | EnumKnob | ColorKnob | UnitIntKnob;
