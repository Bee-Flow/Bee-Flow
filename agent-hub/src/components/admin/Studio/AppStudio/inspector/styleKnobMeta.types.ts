/** A knob measured in whole numbers within a range (a slider). */
interface IntKnob { type: 'int'; min: number; max: number; step: number; default: number }

/** A knob that picks one of a closed list; `null` in the list is "inherit". */
interface EnumKnob { type: 'enum'; values: unknown[]; default: string | null }

/** A knob that takes a colour role or a hex. */
interface ColorKnob { type: 'colorOrRole'; roles: unknown[]; default: null }

/** The range of a unitInt knob under one unit. */
export interface UnitRange { min: number; max: number; step: number; default: number }

/** A number whose legal range depends on the unit its *Mode sibling names. */
interface UnitIntKnob { type: 'unitInt'; modeKnob: 'widthMode' | 'heightMode'; default: null; units: Record<string, UnitRange> }

export type KnobSpec = IntKnob | EnumKnob | ColorKnob | UnitIntKnob;

/** The knob vocabulary: any name looks up a spec or nothing, and the two unit knobs are known to be enums. */
export interface StyleKnobTable {
    [knob: string]: KnobSpec | undefined;
    widthMode: EnumKnob;
    heightMode: EnumKnob;
}
