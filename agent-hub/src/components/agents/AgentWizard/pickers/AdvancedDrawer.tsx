import { X } from 'lucide-react';
import React, { useState } from 'react';
import { CollapsibleSection } from './_primitives';
import { BehaviorBody } from './BehaviorPicker';
import ComplianceBlock from '../../../admin/compliance/ladder/ComplianceBlock';
import Modal from '../../../shared/Modal';
import VersionHistory from '../../VersionHistory';
import type { TranslateParams } from '../../../../hooks/useTranslation';
import type { EditorAgent } from '../builderSplit/editorTypes';

// Right-side slide-in drawer hosting "set-once-and-forget" settings:
// Behavior toggles, Embed/Bubble config, Version History. Replaces the
// previous `···` overflow menu by surfacing all three behind a single gear.
interface AdvancedDrawerProps {
    open: boolean;
    onClose: () => void;
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
    agent: EditorAgent | null | undefined;
    onVersionRestore: () => Promise<void>;
    allowCopy: boolean;
    onToggleAllowCopy: () => void;
    disableExternalTools: boolean;
    onToggleDisableExternalTools: () => void;
    embedEnabled: boolean;
    onToggleEmbedEnabled: () => void;
    bubbleColor: string;
    onBubbleColor: (v: string) => void;
    bubblePosition: string;
    onBubblePosition: (v: string) => void;
    bubbleIcon: string;
    onBubbleIcon: (v: string) => void;
    memoryEnabled: boolean;
    onToggleMemory: () => void;
    useGeneralMemory: boolean;
    onToggleUseGeneralMemory: () => void;
}

export default function AdvancedDrawer({
    open,
    onClose,
    t,
    agent,
    onVersionRestore,
    // Behavior + embed wiring — forwarded straight to BehaviorBody
    allowCopy, onToggleAllowCopy,
    disableExternalTools, onToggleDisableExternalTools,
    embedEnabled, onToggleEmbedEnabled,
    bubbleColor, onBubbleColor,
    bubblePosition, onBubblePosition,
    bubbleIcon, onBubbleIcon,
    memoryEnabled, onToggleMemory,
    useGeneralMemory, onToggleUseGeneralMemory,
}: AdvancedDrawerProps) {
    // Remember which section was last expanded so reopening the drawer in the
    // same page session lands on the user's last context.
    const [openSection, setOpenSection] = useState<string | null>('behavior');
    const handleToggle = (key: string) => {
        setOpenSection(prev => prev === key ? null : key);
    };

    return (
        <Modal
            open={open}
            onClose={() => onClose?.()}
            placement="right"
            size="auto"
            variant="bare"
            zIndex={1100}
            label={t('agent_wizard.builder.advanced_settings', 'Advanced settings')}
            className="w-[400px] max-w-full bg-[var(--bg-card,#fff)] border-l border-[var(--border-default)] shadow-2xl"
        >
            <aside className="h-full flex flex-col">
                <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-default)]">
                    <span className="text-sm font-semibold text-[var(--text-primary)]">
                        {t('agent_wizard.builder.advanced_settings', 'Advanced settings')}
                    </span>
                    <button
                        type="button"
                        onClick={onClose}
                        className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition"
                        title={t('common.close', 'Close')}
                    >
                        <X size={16} />
                    </button>
                </div>
                <div className="flex-1 overflow-y-auto px-5 py-2">
                    <CollapsibleSection
                        title={t('agent_wizard.section.behavior', 'Behavior')}
                        open={openSection === 'behavior'}
                        onToggle={() => handleToggle('behavior')}
                    >
                        <BehaviorBody
                            t={t}
                            agent={agent}
                            allowCopy={allowCopy}
                            onToggleAllowCopy={onToggleAllowCopy}
                            disableExternalTools={disableExternalTools}
                            onToggleDisableExternalTools={onToggleDisableExternalTools}
                            memoryEnabled={memoryEnabled}
                            onToggleMemory={onToggleMemory}
                            useGeneralMemory={useGeneralMemory}
                            onToggleUseGeneralMemory={onToggleUseGeneralMemory}
                            embedEnabled={embedEnabled}
                            onToggleEmbedEnabled={onToggleEmbedEnabled}
                            showEmbedSection={false}
                        />
                    </CollapsibleSection>
                    <CollapsibleSection
                        title={t('agent_wizard.builder.embed_section', 'Embed & bubble')}
                        open={openSection === 'embed'}
                        onToggle={() => handleToggle('embed')}
                    >
                        <BehaviorBody
                            t={t}
                            agent={agent}
                            embedEnabled={embedEnabled}
                            onToggleEmbedEnabled={onToggleEmbedEnabled}
                            bubbleColor={bubbleColor}
                            onBubbleColor={onBubbleColor}
                            bubblePosition={bubblePosition}
                            onBubblePosition={onBubblePosition}
                            bubbleIcon={bubbleIcon}
                            onBubbleIcon={onBubbleIcon}
                            showBehaviorToggles={false}
                        />
                    </CollapsibleSection>
                    {agent?.id && (
                        <CollapsibleSection
                            title={t('agent_wizard.section.versions', 'Version History')}
                            open={openSection === 'versions'}
                            onToggle={() => handleToggle('versions')}
                        >
                            <VersionHistory agentId={agent.id} onRestore={onVersionRestore} />
                        </CollapsibleSection>
                    )}
                    {agent?.id && (
                        <CollapsibleSection
                            title={t('compliance.ladder_section_title', 'Compliance')}
                            open={openSection === 'compliance'}
                            onToggle={() => handleToggle('compliance')}
                        >
                            {/* AI Act ladder (FE-8). The drawer sits at z-[1100];
                                the ladder's modal must open above it. */}
                            <ComplianceBlock kind="agent" target={agent} modalZIndex={1200} />
                        </CollapsibleSection>
                    )}
                </div>
            </aside>
        </Modal>
    );
}
