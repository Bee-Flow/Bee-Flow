import React from 'react';
import { useTranslation } from '../../../hooks/useTranslation';
import type { SettingsUser } from './settingsShellTypes';

interface AvatarDisplayProps {
    user?: SettingsUser | null;
    size?: number;
    className?: string;
}

export const AvatarDisplay = ({ user, size = 40, className = '' }: AvatarDisplayProps) => {
    const { t } = useTranslation();
    const sizeStyle = { width: `${size}px`, height: `${size}px`, flexShrink: 0 };
    if (user?.avatarType === 'emoji' && user?.avatar) {
        return (
            <div
                className={`rounded-full flex items-center justify-center ${className}`}
                style={{ ...sizeStyle, background: 'var(--bg-tertiary)', border: '1px solid var(--border-default)', fontSize: `${size * 0.5}px`, lineHeight: 1 }}
            >
                {user.avatar}
            </div>
        );
    }
    if (user?.avatarType === 'url' && user?.avatar) {
        return <img src={user.avatar} alt={t('settings.avatar_alt', 'Avatar')} className={`rounded-full object-cover ${className}`} style={sizeStyle} />;
    }
    return (
        <div
            className={`rounded-full flex items-center justify-center font-bold ${className}`}
            style={{ ...sizeStyle, background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border-default)', fontSize: `${Math.round(size * 0.38)}px` }}
        >
            {(user?.displayName || user?.username || 'U')[0].toUpperCase()}
        </div>
    );
};
