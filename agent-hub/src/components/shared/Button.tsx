import React from 'react';
import { buttonClass } from './buttonClasses';
import type { ButtonSize, ButtonVariant } from './buttonClasses';

/**
 * The one Button primitive: six variants, three sizes, optional leading icon
 * component and trailing node, and `busy` disables it while work is in flight.
 * The colours live in `buttonClasses.ts` (theme tokens only), so class kits
 * such as SAVE_BUTTON and PRIMARY_BTN share them.
 */

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: ButtonVariant;
    size?: ButtonSize;
    icon?: React.ComponentType<{ className?: string }>;
    iconRight?: React.ReactNode;
    busy?: boolean;
}

export function Button({
    variant = 'primary',
    size = 'md',
    icon: Icon,
    iconRight,
    children,
    className = '',
    type = 'button',
    busy = false,
    disabled,
    ...rest
}: ButtonProps) {
    return (
        <button
            type={type}
            {...rest}
            // After the spread: an explicit disabled={false} must not re-enable a busy button.
            disabled={busy || disabled}
            aria-busy={busy || undefined}
            className={`${buttonClass(variant, size)} ${className}`}
        >
            {Icon && <Icon className={size === 'sm' ? 'w-3.5 h-3.5' : 'w-4 h-4'} />}
            {children}
            {iconRight}
        </button>
    );
}

export default Button;
