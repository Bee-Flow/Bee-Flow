/**
 * The slots a register may fill with its own component, beside the generic
 * list and detail: above the list rows, above a record's facts, and after its
 * history. The wiring package passes them per register type to RecordList
 * and RecordDetail. A detail panel runs the register's actions by id through
 * the detail's own action runner (confirm, sheets, toasts included).
 */

import type { ComponentType } from 'react';

import type { Formatter, Rec, RecordSet, RecordType } from '../model/types';

export interface ListPanelProps {
    type: RecordType;
    set: RecordSet;
}

export interface DetailPanelProps {
    type: RecordType;
    rec: Rec;
    fmt: Formatter;
    /** Run the register action with this id on this record. */
    runAction: (id: string) => void;
}

export interface RecordPanels {
    ListTop?: ComponentType<ListPanelProps>;
    DetailTop?: ComponentType<DetailPanelProps>;
    DetailBottom?: ComponentType<DetailPanelProps>;
}
