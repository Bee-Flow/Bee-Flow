import type { ComponentType } from 'react';
import AppIconJs from '../../../../icons/AppIcon';

/**
 * AppIcon is plain JS behind a forwardRef, so the compiler sees no props
 * through it. This is the slice of them the gallery passes.
 */
const AppIcon = AppIconJs as unknown as ComponentType<{ name: string; className?: string }>;

export default AppIcon;
