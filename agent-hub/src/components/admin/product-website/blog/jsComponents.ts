import type { ComponentType, ReactNode } from 'react';
import {
    ImageField as ImageFieldJs, TextField as TextFieldJs, TextArea as TextAreaJs,
    Toggle as ToggleJs, FieldRow as FieldRowJs,
} from '../fields';
import {
    CollapsibleCard as CollapsibleCardJs, InlineHint as InlineHintJs, SegmentedControl as SegmentedControlJs,
} from '../primitives';
import AssetPickerDialogJs from '../dialogs/AssetPickerDialog';
import AppIconJs from '../../../icons/AppIcon';
import { SectionHeaderFields as SectionHeaderFieldsJs } from '../blockEditors/shared';

// fields.jsx / primitives.jsx are plain JS: TypeScript infers every
// destructured prop as required although they all have defaults (same note
// as blockEditors/ClipFields.tsx). These are the props the blog editor uses.

type Props = Record<string, unknown> & { children?: ReactNode };

export const ImageField = ImageFieldJs as unknown as ComponentType<{ value: string; onChange: (v: string) => void; label?: string; placeholder?: string }>;
export const TextField = TextFieldJs as unknown as ComponentType<{ value: string; onChange: (v: string) => void; label?: string; placeholder?: string; hint?: ReactNode }>;
export const TextArea = TextAreaJs as unknown as ComponentType<{ value: string; onChange: (v: string) => void; label?: string; placeholder?: string; hint?: ReactNode; rows?: number }>;
export const Toggle = ToggleJs as unknown as ComponentType<{ value: boolean; onChange: (v: boolean) => void; label: string }>;
export const FieldRow = FieldRowJs as unknown as ComponentType<{ label?: string; hint?: ReactNode; children?: ReactNode }>;
export const CollapsibleCard = CollapsibleCardJs as unknown as ComponentType<{ title: string; defaultOpen?: boolean; persistKey?: string | null; children?: ReactNode }>;
export const InlineHint = InlineHintJs as unknown as ComponentType<{ children?: ReactNode }>;
export const SegmentedControl = SegmentedControlJs as unknown as ComponentType<{
    options: { value: string; label: string; hint?: string }[];
    value: string;
    onChange: (v: string) => void;
}>;
export const AssetPickerDialog = AssetPickerDialogJs as unknown as ComponentType<{
    onPick: (url: string) => void;
    onClose: () => void;
    accept?: 'image' | 'video' | 'captions';
}>;
export const SectionHeaderFields = SectionHeaderFieldsJs as unknown as ComponentType<Props>;
export const AppIcon = AppIconJs as unknown as ComponentType<{ name: string; className?: string }>;
