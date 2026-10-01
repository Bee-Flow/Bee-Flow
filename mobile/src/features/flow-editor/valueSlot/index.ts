/**
 * The phone's value fields for the v2 mapping: a value picked from an earlier
 * step as a chip with its name (never a path), the sentence that says what
 * the field gets, and the sheet that changes it — the web's
 * Builder/valueSlot/ on a phone. The model is the shared mapping core's
 * (`@/shared/mapping`); components/fields/BindingInput puts these in every
 * field that holds a value.
 */

export { composeToText, markerFor, markersIn, plainText, textToCompose, type ComposeText, type MarkerAt } from './composeText';
export { PickedValue, type PickedValueProps } from './PickedValue';
export { formulaSummary, pickLabel, type PickLike } from './pickLabel';
export { optionLabel, PickOptionsSheet, type PickOptionsSheetProps } from './PickOptionsSheet';
export { pickSentence } from './pickSentence';
export * from './slotModel';
export { ValueChip, type ValueChipProps, type ValueChipState } from './ValueChip';
