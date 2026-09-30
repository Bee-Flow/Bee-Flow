/**
 * The shared parameter-row designer — a flowlet's inputs, an agent tool's
 * parameters and a Studio App trigger's inputs are one list with different
 * words and type sets (the web's FieldDesigner). Writes go through the LATEST
 * list: a name commits when its box loses focus, and that is usually the tap
 * on "Add" or a bin — which must not rebuild the list from a copy that
 * predates the rename.
 */

import React, { useEffect, useRef } from 'react';

import { ParamRow } from './ParamRow';
import { addParam, type ParamRow as Row } from './paramsModel';
import type { Msg, OptionSpec } from '../declarative/spec';
import { AddButton } from '../shared/AddButton';
import { patchAt, removeAt } from '../shared/list';
import { Note } from '../shared/Note';

export interface ParamsDesignerProps {
    rows: unknown;
    onChange: (next: Row[]) => void;
    types: readonly OptionSpec[];
    addLabel: string;
    removeLabel: string;
    emptyNote: string;
    /** What a new row is called: `input1`, `arg2`. */
    namePrefix: string;
    /** Null where the call site has no description. */
    descriptionPlaceholder?: string | null;
    sanitizeName?: ((s: string) => string) | null;
    takenError: Msg;
    defaults?: Partial<Row> | null;
    carry?: ((from: string, to: string) => number | undefined) | null;
    disabled?: boolean;
}

export function ParamsDesigner(props: ParamsDesignerProps) {
    const list = Array.isArray(props.rows) ? (props.rows as Row[]) : [];
    const latest = useRef(list);
    useEffect(() => {
        latest.current = list;
    });
    const write = (fn: (cur: Row[]) => Row[]) => {
        const next = fn(latest.current);
        latest.current = next;
        props.onChange(next);
    };
    const disabled = props.disabled ?? false;
    return (
        <>
            {list.length === 0 ? <Note>{props.emptyNote}</Note> : null}
            {list.map((row, i) => (
                <ParamRow
                    key={i}
                    row={row || {}}
                    position={i + 1}
                    siblings={list}
                    types={props.types}
                    removeLabel={props.removeLabel}
                    descriptionPlaceholder={props.descriptionPlaceholder ?? null}
                    sanitizeName={props.sanitizeName ?? null}
                    takenError={props.takenError}
                    carry={props.carry ?? null}
                    onPatch={(patch) => write((cur) => patchAt(cur, i, patch))}
                    onRemove={() => write((cur) => removeAt(cur, i))}
                    disabled={disabled}
                />
            ))}
            <AddButton label={props.addLabel} onPress={() => write((cur) => addParam(cur, props.namePrefix, props.defaults ?? null))} disabled={disabled} />
        </>
    );
}
