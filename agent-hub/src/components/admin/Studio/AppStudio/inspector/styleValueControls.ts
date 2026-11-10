/**
 * App Studio inspector: the control of a style knob whose value type was added after the
 * base ones.
 *
 * StyleSection draws int, enum and colorOrRole knobs itself. A knob of any other value type
 * (server/appStudio/componentSpecs/valueTypes.js: asset, css) is drawn by the control
 * registered for that type: one file, styleValueControls/<type>.tsx, whose default export
 * is a component taking StyleValueControlProps. The files are found by import.meta.glob. A
 * knob whose type has no control is not drawn. The directory ships empty, and no knob uses
 * such a type yet.
 */

import type { AppDefinition } from './appDefinition';
import type { ComponentType } from 'react';

export interface StyleValueControlProps {
    /** The knob's name, e.g. `backgroundImage`. */
    knob: string;
    /** The knob's spec from the catalogue snapshot; the control knows which other fields its type carries. */
    spec: { type: string };
    /** The stored value; undefined or null when the knob is not set. */
    value: unknown;
    /** Commit a value; null clears the knob. */
    onChange: (value: unknown) => void;
    definition: AppDefinition;
    disabled: boolean;
}

export type StyleValueControl = ComponentType<StyleValueControlProps>;

type ControlModules = Record<string, { default?: StyleValueControl }>;

/** The value types StyleSection (and its advanced sizing block) draws without a registered control. */
const BASE_VALUE_TYPES: readonly string[] = ['int', 'enum', 'colorOrRole', 'unitInt'];

export const isBaseValueType = (type: string): boolean => BASE_VALUE_TYPES.includes(type);

function controlModules(): ControlModules {
    try {
        // No type argument on the call, on purpose: vitest keeps a transformed module on disk
        // between runs unless its text holds the call exactly as `import.meta.glob(`, and a
        // kept copy would not see a file added to the folder.
        return import.meta.glob(['./styleValueControls/*.tsx', '!./styleValueControls/*.test.tsx'], { eager: true }) as Record<string, { default?: StyleValueControl }>;
    } catch {
        return {};
    }
}

function typeOfPath(file: string): string {
    const name = file.slice(file.lastIndexOf('/') + 1);
    return name.endsWith('.tsx') ? name.slice(0, -'.tsx'.length) : name;
}

/** The controls of `modules`, keyed by value type (the file name). */
export function collectStyleValueControls(modules: ControlModules): Record<string, StyleValueControl> {
    const out: Record<string, StyleValueControl> = {};
    for (const file of Object.keys(modules).sort()) {
        const type = typeOfPath(file);
        const control = modules[file]?.default;
        if (isBaseValueType(type)) throw new Error(`styleValueControls/${type}.tsx: "${type}" is drawn by StyleSection itself`);
        if (!control) throw new Error(`styleValueControls/${type}.tsx: the default export is the control component`);
        out[type] = control;
    }
    return out;
}

export const STYLE_VALUE_CONTROLS: Readonly<Record<string, StyleValueControl>> = collectStyleValueControls(controlModules());
