import React from 'react';
import { CHIP, CHIP_INFO, CHIP_SUCCESS, CHIP_WARNING } from '@/components/shared/adminUi';

/**
 * The small status pill of the provider panes (runtime type, "from
 * environment", a model's tier, a model count), in the theme's chip recipes.
 * Inputs use FIELD_INPUT from the shared SettingsList, like the rest of AI
 * configuration.
 */

const TONE_CLS = {
    neutral: CHIP,
    info: CHIP_INFO,
    success: CHIP_SUCCESS,
    warning: CHIP_WARNING,
};

interface ProviderStatusPillProps {
    tone?: keyof typeof TONE_CLS;
    children?: React.ReactNode;
}

/** A small rounded status pill. */
export const ProviderStatusPill = ({ tone = 'neutral', children }: ProviderStatusPillProps) => (
    <span className={TONE_CLS[tone]}>{children}</span>
);
