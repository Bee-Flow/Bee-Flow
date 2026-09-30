/**
 * The UI kit's public surface: one primitive per file, all imported from
 * '@/shared/ui'. Files inside the kit import each other relatively (never this
 * barrel), so there is no cycle through here.
 */

// Layout and surfaces
export { Screen, useBottomInset, type ScreenProps } from './Screen';
export { ScreenHeader, type ScreenHeaderProps } from './ScreenHeader';
export { HeaderAccessoryProvider, useHeaderAccessories, type HeaderAccessory } from './headerAccessories';
export { HeaderSearchButton } from './HeaderSearchButton';
export { HeaderMenuProvider, useHeaderMenu, type HeaderMenu } from './headerMenu';
export { Card, type CardProps } from './Card';
export { Section } from './Section';
export { Divider } from './Divider';
export { InsetDivider } from './InsetDivider';
export { Spacer } from './Spacer';
export { Group } from './Group';
export { GroupedScroll, type GroupedScrollProps } from './GroupedScroll';
export { Sheet } from './Sheet';
export { ConfirmSheet, type ConfirmSheetProps } from './ConfirmSheet';
export { GuardedDeleteSheet, kindLabel, needsTypedName, typedNameMatches } from './GuardedDeleteSheet';
export { ActionMenu, type ActionMenuItem, type ActionMenuProps } from './ActionMenu';

// Studio objects
export { ObjectHeader, type ObjectHeaderProps } from './ObjectHeader';
export { TabBar, scrollTargetFor, type TabBarItem, type TabBarProps } from './TabBar';
export { KindTile, type KindTileProps } from './KindTile';
export { IconTile, type IconTileProps } from './IconTile';
export {
    KIND_ICON,
    KIND_KEYS,
    kindColor,
    kindOf,
    tileMetrics,
    type KindInput,
    type KindKey,
} from './kinds';
export { DataList, type DataListProps } from './DataList';
export { DataListHeader, DataListRow, columnStyle, type DataColumn, type DataListRowProps } from './DataListRow';

// Navigation
export { NavRow, navCount, plainCount, type NavRowProps } from './nav/NavRow';
export { SectionLabel, type SectionLabelProps } from './nav/SectionLabel';

// Text and marks
export { Text, type TextProps, type TextTone, type TextVariant } from './Text';
export { Icon, ACTIVE_STROKE, DEFAULT_STROKE, isIconName, type IconName, type IconProps } from './icons/Icon';
export { AppIcon, resolveAppIcon, type AppIconProps } from './icons/AppIcon';
export { Badge, type BadgeTone } from './Badge';
export { Chip, pillColors, type ChipProps, type ChipTone } from './Chip';
export { FilterPills, type FilterPillOption } from './FilterPills';
export { ScreenTabs } from './ScreenTabs';
export { CheckRow } from './CheckRow';
export { Avatar } from './Avatar';
export { BrandMark, brandMarkSource } from './BrandMark';
export { tonePair, chipColors, TONES, type Tone, type TonePair } from './tones';
export { tint } from './tint';
export { Illustration, type IllustrationName } from './illustrations';

// Actions and inputs
export { Button, buttonColors, type ButtonProps, type ButtonSize, type ButtonVariant } from './Button';
export { IconButton, type IconButtonTone } from './IconButton';
export { TextField, type TextFieldProps } from './TextField';
export { SearchField } from './SearchField';
export { Switch } from './Switch';
export { Segmented, type SegmentedCountTone, type SegmentedOption } from './Segmented';
export { TagInput, addTag, type TagInputHandle, type TagInputProps } from './TagInput';
export { Stepper, stepValue, type StepBounds, type StepperProps } from './Stepper';
export { SaveBar, type SaveBarProps } from './SaveBar';

// Rows
export { ListRow, type ListRowProps } from './ListRow';
export { SettingRow } from './SettingRow';
export { ToggleRow } from './ToggleRow';
export { OptionRow } from './OptionRow';
export { InfoRow } from './InfoRow';
export { NoteRow } from './NoteRow';
export { BadgeRow } from './BadgeRow';

// Feedback
export { Spinner } from './Spinner';
export { LoadingState } from './LoadingState';
export { EmptyState, type EmptyStateProps } from './EmptyState';
export { ErrorState, type ErrorStateProps } from './ErrorState';
export { Skeleton, type SkeletonProps } from './Skeleton';
export { ListSkeleton } from './ListSkeleton';
export { ProgressBar, progressPercent, type ProgressBarProps } from './ProgressBar';
export { Banner, type BannerProps, type BannerTone } from './Banner';
export { ToastProvider, useToast } from './Toast';

// Charts
export { BarChart, type Column } from './BarChart';
export { Meter } from './Meter';
export { Stat } from './Stat';
