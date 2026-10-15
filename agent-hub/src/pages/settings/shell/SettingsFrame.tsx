import { ArrowLeft } from 'lucide-react';
import React from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from '../../../hooks/useTranslation';

/** The settings title bar: the phone back button and the section (or screen) title. */
export function SettingsTitleBar({ titleLabel, onBack }: { titleLabel: string; onBack: () => void }) {
    const { t } = useTranslation();
    return (
        <div
            className="flex-shrink-0 flex items-center gap-2 px-5"
            style={{ height: '48px', background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-subtle)' }}
        >
            {/* Phone back button. In a section (detail) it returns to the
                section list; on the list it exits Settings back to chat —
                phones have no persistent sidebar while Settings is open.
                Desktop keeps the sidebar, so the button is hidden there. */}
            <button
                onClick={onBack}
                className="md:hidden -ml-2 mr-0.5 p-1.5 rounded-lg text-[var(--text-secondary)]"
                aria-label={t('common.back', 'Back')}
            >
                <ArrowLeft className="w-5 h-5" />
            </button>
            <span className="text-[15px] font-semibold text-[var(--text-primary)]">{titleLabel}</span>
        </div>
    );
}

interface SettingsContentPanelProps {
    mobileDetail: boolean;
    activeTab: string;
    isOrgSubTab: boolean;
    children: ReactNode;
}

/** The content column next to the sidebar; sections that own their viewport get the full width. */
export function SettingsContentPanel({ mobileDetail, activeTab, isOrgSubTab, children }: SettingsContentPanelProps) {
    return (
        <div className={`flex-1 overflow-auto ${mobileDetail ? 'block' : 'hidden md:block'}`} style={{ background: 'var(--bg-primary)' }}>
            <div
                // Every organisation page and every consumer account
                // page gets the wide column: the consumer licence page
                // is the same plan grid as the org one, and squeezed
                // into 640px it lost its columns. Personal settings
                // keep the reading width.
                className={`mx-auto py-6 md:py-8 px-4 md:px-8 ${(isOrgSubTab || activeTab.startsWith('consumer_')) ? 'max-w-5xl' : 'max-w-[640px]'}`}
                style={activeTab === 'org_usage' ? { maxWidth: '100%', padding: '24px 32px 32px' }
                    // Sections that own their whole viewport: they bring
                    // their own header, their own scroll region and their
                    // own padding, and they pin a bar to the bottom. The
                    // shared `max-w-5xl` + `py-8 px-8` wrapper fights all
                    // three — it caps a 3355px screen at 1024px (leaving
                    // two thirds of it empty while the content inside
                    // wraps), and `height:100%` is what lets a pinned save
                    // bar actually reach the bottom instead of floating
                    // under the last card.
                    : (activeTab === 'org_compliance' || activeTab === 'learning' || activeTab === 'privacy')
                        ? { maxWidth: '100%', padding: 0, height: '100%' }
                        : undefined}
            >
                {children}
            </div>
        </div>
    );
}
