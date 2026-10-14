import type { ComponentType } from 'react';
import AppIconJs from '../../../icons/AppIcon';
import IconPickerJs from '../controls/IconPicker';
import AssetPickerDialogJs from '../dialogs/AssetPickerDialog';

// The JS components the field kit renders. TypeScript reads their
// destructured props as required and their `= null` defaults as "always
// null"; these are the props the kit passes (same approach as
// blog/jsComponents.ts, kept separate so the kit does not import the blog).

export const AppIcon = AppIconJs as unknown as ComponentType<{ name: string; className?: string }>;

export const IconPicker = IconPickerJs as unknown as ComponentType<{
    value: string;
    onSelect: (name: string) => void;
    onClose: () => void;
}>;

export const AssetPickerDialog = AssetPickerDialogJs as unknown as ComponentType<{
    onPick: (url: string) => void;
    onClose: () => void;
    accept?: string;
}>;
