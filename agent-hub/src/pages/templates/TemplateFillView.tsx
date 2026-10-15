import React from 'react';
import type { RefObject } from 'react';
import { FillHeader, FillSidebar } from './TemplateFillChrome';
import { FillChatPanel, FillSettingsPanel } from './TemplateFillPanels';
import type { FillHeaderProps, FillSidebarProps } from './TemplateFillChrome';
import type { FillChatPanelProps, FillSettingsPanelProps } from './TemplateFillPanels';

export type TemplateFillViewProps = FillHeaderProps & FillSidebarProps & FillSettingsPanelProps & FillChatPanelProps;

/** The AI fill view of one template: header, parameter sidebar and the chat or settings panel. */
export default function TemplateFillView(props: TemplateFillViewProps) {
    const { showSettings } = props;
    return (
        <div className="h-full flex flex-col bg-[var(--bg-primary)]">
            <FillHeader {...props} />
            <div className="flex-1 flex overflow-hidden">
                <FillSidebar {...props} />
                <div className="flex-1 flex flex-col min-w-0">
                    {showSettings ? <FillSettingsPanel {...props} /> : <FillChatPanel {...props} />}
                </div>
            </div>
        </div>
    );
}
