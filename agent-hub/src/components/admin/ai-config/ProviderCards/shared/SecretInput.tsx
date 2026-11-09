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
                className="w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-primary)] px-3 py-1.5 pr-10 text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)]"
                onKeyDown={onEnter ? ((e: React.KeyboardEvent<HTMLInputElement>) => e.key === 'Enter' && onEnter()) : undefined}
            />
            <button
                type="button"
                onClick={toggleShow}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-white/10 text-[var(--text-muted)]"
                title={visible ? 'Hide' : 'Show'}
            >
                {visible ? '👁️' : '👁️‍🗨️'}
            </button>
        </div>
    );
};

export default SecretInput;
