import { ArrowLeft } from 'lucide-react';
import AgentWizard from '../AgentWizard/index';
import type { TranslateFn } from '@/hooks/useTranslation';

interface Props {
    t: TranslateFn;
    user: unknown;
    onClose: (() => void) | null | undefined;
    onBack: () => void;
    onSwitchToManual: () => void;
    onPublished: (agent: { id?: string | null } | null | undefined) => Promise<void>;
}

/**
 * The wizard state of the Studio: the AI landing with a way back and the
 * "create empty" exit. The landing draws neither itself; both belong here,
 * otherwise the wizard is a dead end.
 */
export default function WizardLanding({ t, user, onClose, onBack, onSwitchToManual, onPublished }: Props) {
    return (
        <div className="flex-1 min-h-0 flex flex-col">
            <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-[var(--border-default)]">
                <button
                    type="button"
                    onClick={onBack}
                    className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] transition"
                >
                    <ArrowLeft size={14} aria-hidden="true" />
                    {t('agent_studio.header.back_to_agents', 'Back to Agents')}
                </button>
                <button
                    type="button"
                    onClick={onSwitchToManual}
                    className="h-8 px-2.5 rounded-lg text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] transition"
                >
                    {t('agent_studio.create_empty', 'Create empty agent')}
                </button>
            </div>
            <div className="flex-1 min-h-0">
                <AgentWizard
                    user={user}
                    onClose={onClose}
                    onSwitchToManual={onSwitchToManual}
                    onPublished={onPublished}
                />
            </div>
        </div>
    );
}
