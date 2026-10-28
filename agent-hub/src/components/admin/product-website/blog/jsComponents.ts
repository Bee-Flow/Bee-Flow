import {
    ImageField as ImageFieldJs, TextField as TextFieldJs, TextArea as TextAreaJs,
    Toggle as ToggleJs, FieldRow as FieldRowJs,
} from '../fields';
import {
    CollapsibleCard as CollapsibleCardJs, InlineHint as InlineHintJs, SegmentedControl as SegmentedControlJs,
} from '../primitives';
import AssetPickerDialogJs from '../dialogs/AssetPickerDialog';
import AppIconJs from '@/components/icons/AppIcon';
import { SectionHeaderFields as SectionHeaderFieldsJs } from '../blockEditors/shared';

// The blog editor's view of the field kit: the typed components themselves,
// re-exported under one roof.

export const ImageField = ImageFieldJs;
export const TextField = TextFieldJs;
export const TextArea = TextAreaJs;
export const Toggle = ToggleJs;
export const FieldRow = FieldRowJs;
export const CollapsibleCard = CollapsibleCardJs;
export const InlineHint = InlineHintJs;
export const SegmentedControl = SegmentedControlJs;
export const AssetPickerDialog = AssetPickerDialogJs;
export const SectionHeaderFields = SectionHeaderFieldsJs;
export const AppIcon = AppIconJs;
