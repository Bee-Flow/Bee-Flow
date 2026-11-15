// Masked secret input with a show/hide toggle — replaces the
//
//   <div className="relative flex-1">
//       <input type={showKey ? 'text' : 'password'} ... />
//       <button onClick={() => setShowKey(!showKey)}>👁️</button>
//   </div>
//
// block that was copy-pasted across the provider API-key cards and
// RerankerConfig. Visibility state is internal by default; pass `show` +
// `onToggleShow` to control it from the parent (e.g. to re-mask the field
// after a successful save, like ProviderApiKeyCard does).
//
// `onChange` receives the raw string value (not the event); `onEnter`
// (optional) runs on the Enter key for save-on-Enter cards.

import React, { useState } from 'react';
import { FIELD_INPUT } from '@/components/shared/SettingsList';
import { useTranslation } from '@/hooks/useTranslation';

interface SecretInputProps {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    onEnter?: () => void;
    show?: boolean;
    onToggleShow?: (show: boolean) => void;
    className?: string;
}

const SecretInput = ({ value, onChange, placeholder, onEnter, show, onToggleShow, className = 'relative flex-1' }: SecretInputProps) => {
    const { t } = useTranslation();
    const [internalShow, setInternalShow] = useState(false);
    const isControlled = show !== undefined;
    const visible = isControlled ? show : internalShow;

    const toggleShow = () => {
        if (isControlled) onToggleShow?.(!visible);
        else setInternalShow(v => !v);
    };

    return (
        <div className={className}>
            <input
                type={visible ? 'text' : 'password'}
                value={value}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
                placeholder={placeholder}
                className={`${FIELD_INPUT} pr-10`}
                onKeyDown={onEnter ? ((e: React.KeyboardEvent<HTMLInputElement>) => e.key === 'Enter' && onEnter()) : undefined}
            />
            <button
                type="button"
                onClick={toggleShow}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-[var(--text-tertiary)] hover:bg-[var(--item-hover-bg)]"
                title={visible ? t('ai_model_setup.secret_hide', 'Hide') : t('ai_model_setup.secret_show', 'Show')}
                aria-label={visible ? t('ai_model_setup.secret_hide', 'Hide') : t('ai_model_setup.secret_show', 'Show')}
            >
                {visible ? '👁️' : '👁️‍🗨️'}
            </button>
        </div>
    );
};

export default SecretInput;
