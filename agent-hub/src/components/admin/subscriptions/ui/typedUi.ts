import type { ComponentType, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Badge as BadgeJs } from './Badge';
import { Banner as BannerJs } from './Banner';
import { Card as CardJs } from './Card';
import { SectionHeader as SectionHeaderJs } from './SectionHeader';
import { Spinner as SpinnerJs } from './Spinner';
import { Toggle as ToggleJs, Checkbox as CheckboxJs } from './Toggle';

// The console's UI kit is plain JS: TypeScript reads every destructured prop
// without a default as required. These are the props the TypeScript views
// pass (same approach as product-website/blog/jsComponents.ts).

type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export const Badge = BadgeJs as unknown as ComponentType<{
    tone?: Tone;
    icon?: LucideIcon;
    size?: 'sm' | 'md';
    className?: string;
    children?: ReactNode;
}>;

export const Banner = BannerJs as unknown as ComponentType<{
    tone?: Tone;
    icon?: LucideIcon;
    title?: ReactNode;
    className?: string;
    children?: ReactNode;
}>;

export const Card = CardJs as unknown as ComponentType<{
    className?: string;
    accent?: string;
    padded?: boolean;
    hover?: boolean;
    children?: ReactNode;
}>;

export const SectionHeader = SectionHeaderJs as unknown as ComponentType<{
    title: ReactNode;
    description?: ReactNode;
    action?: ReactNode;
    className?: string;
}>;

export const Spinner = SpinnerJs as unknown as ComponentType<{ label?: string; className?: string }>;

export const Toggle = ToggleJs as unknown as ComponentType<{
    checked: boolean;
    onChange: (checked: boolean) => void;
    disabled?: boolean;
    label: ReactNode;
    description?: ReactNode;
    icon?: LucideIcon;
    iconClass?: string;
}>;

export const Checkbox = CheckboxJs as unknown as ComponentType<{
    checked: boolean;
    onChange: (checked: boolean) => void;
    label: ReactNode;
    accent?: string;
    disabled?: boolean;
}>;
