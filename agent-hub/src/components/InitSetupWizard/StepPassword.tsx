import React from 'react';
import { useTranslation } from '../../hooks/useTranslation';

interface StepPasswordProps {
    password: string;
    setPassword: (value: string) => void;
    confirmPassword: string;
    setConfirmPassword: (value: string) => void;
    inputClass: string;
    inputStyle: React.CSSProperties;
    onNext: () => void;
}

const StepPassword = ({ password, setPassword, confirmPassword, setConfirmPassword, inputClass, inputStyle, onNext }: StepPasswordProps) => {
    const { t } = useTranslation();
    return (
    <>
        <div>
            <label className="block text-sm font-medium mb-1.5 text-[var(--text-secondary)]">{t('init_setup.step_password_admin_password', 'Admin Password')}</label>
            <input
                type="password" value={password} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)}
                placeholder={t('init_setup.step_password_min_8_chars_upper_lower_number', 'Min 8 chars, upper + lower + number')}
                className={inputClass} style={inputStyle}
                onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => e.key === 'Enter' && onNext()}
            />
        </div>
        <div>
            <label className="block text-sm font-medium mb-1.5 text-[var(--text-secondary)]">{t('init_setup.step_password_confirm_password', 'Confirm Password')}</label>
            <input
                type="password" value={confirmPassword} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfirmPassword(e.target.value)}
                placeholder={t('init_setup.step_password_re_enter_password', 'Re-enter password')}
                className={inputClass} style={inputStyle}
                onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => e.key === 'Enter' && onNext()}
            />
        </div>
    </>
);
};

export default StepPassword;
