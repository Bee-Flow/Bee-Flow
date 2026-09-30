/**
 * A field's place as "where the author was typing": registered with the
 * variable picker when the field gains focus, so a tap in the Input tab lands
 * there, and released when the field goes away (a removed row, another step),
 * so a later tap never writes into a field that is no longer on screen.
 */

import { useEffect, useRef, type RefObject } from 'react';

import type { ActiveField, VariablePickerValue } from '../variables';

export function useActiveField(picker: VariablePickerValue, label: string, insert: RefObject<(path: string) => void>): () => void {
    const registered = useRef<ActiveField | null>(null);
    const latest = useRef(picker);
    useEffect(() => {
        latest.current = picker;
    });
    useEffect(
        () => () => {
            if (registered.current) latest.current.release(registered.current);
        },
        [],
    );
    return () => {
        const field: ActiveField = { label, insert: (path) => insert.current(path) };
        registered.current = field;
        picker.focus(field);
    };
}
