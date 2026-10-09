import React from 'react';
import { useTranslation } from '../../hooks/useTranslation';

const StepPassword = ({ password, setPassword, confirmPassword, setConfirmPassword, inputClass, inputStyle, onNext }) => {
    const { t } = useTranslation();
    return (
    <>
        <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>{t('init_setup.step_password_admin_password', 'Admin Password')}</label>
            <input
                type="password" value={password} onChange={e => setPassword(e.target.value)}
                placeholder={t('init_setup.step_password_min_8_chars_upper_lower_number', 'Min 8 chars, upper + lower + number')}
                className={inputClass} style={inputStyle}
                onKeyDown={e => e.key === 'Enter' && onNext()}
            />
        </div>
        <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>{t('init_setup.step_password_confirm_password', 'Confirm Password')}</label>
            <input
                type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)}
                placeholder={t('init_setup.step_password_re_enter_password', 'Re-enter password')}
                className={inputClass} style={inputStyle}
                onKeyDown={e => e.key === 'Enter' && onNext()}
            />
        </div>
    </>
);
};

export default StepPassword;
