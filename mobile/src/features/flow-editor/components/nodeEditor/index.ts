/**
 * The node editor: one step, edited in three tabs (Input | Settings |
 * Output), and the pieces every step editor builds from — Section (an
 * accordion band that knows Simple mode), the density rules, the form over
 * the draft store.
 */

export { NodeEditor, type NodeEditorProps, type NodeEditorTab } from './NodeEditor';
export { isNestedAddress, positionAt, upstreamGroupsAt } from './address';
export { Section, type SectionProps } from './Section';
export { ADVANCED_SECTION_KEYS, FORM_MODES, hiddenInSimple, hiddenSectionCount, isAdvancedSection, sectionShown } from './density';
export { formWriteOp, patchWriteOp, writeStepPatch } from './stepForm';
export { useStepForm, type StepFormState } from './useStepForm';
export { useNodeEditor, type NodeEditorModel } from './useNodeEditor';
export { headerKicker, headerTitle, stepTypeLabel } from './headerText';
export { FamilyTile } from './FamilyTile';
export { checkOutputText, editedOutputPatch, outputSeed, outputState, pinPatch, unpinPatch } from './outputEdit';
export { copyText, treeRows, type TreeRow } from './jsonTree';
