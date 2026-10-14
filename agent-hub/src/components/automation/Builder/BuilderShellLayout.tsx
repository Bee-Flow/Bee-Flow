import type { ReactNode } from 'react';
import { readinessStamp } from '../../../api/queries/automation/readiness';
import { BuilderConfirmProvider } from './BuilderConfirmContext';
import BuilderHeader from './BuilderHeader';
import AiActQuestionsDialog from './settings/AiActQuestionsDialog';
import SettingsTab from './SettingsTab';
import TriggerDiagnosePanel from './TriggerDiagnosePanel';

/**
 * What BuilderShell computed this render; the layout only arranges it. The
 * Editor, Version history and Run history views come in ready-made: their
 * components sit on the Studio import cycle (BuildTab, VersionsTab, RunsTab,
 * ExecutionsPanel all lead back to the shell), and a layout importing them
 * would join that cycle.
 */
export interface BuilderShellLayoutProps {
    /** useConfirm's ask; published to every panel through BuilderConfirmContext. */
    confirm: any;
    confirmDialog: ReactNode;
    aiActGate: { action: any } | null;
    setAiActGate: (gate: { action: any } | null) => void;
    retryAfterAiAct: () => void;
    serverAutomation: any;
    state: any;
    tab: string;
    setTab: (tab: string) => void;
    headerProps: any;
    diagnoseOpen: boolean;
    diagnoseResult: any;
    diagnoseLoading: boolean;
    diagnoseError: any;
    setDiagnoseOpen: (open: boolean) => void;
    diagnoseAnchorRef: any;
    onSaveAutomation: (patch: any) => Promise<void>;
    settingsSection: string | null;
    workMode: string;
    setWorkMode: (mode: string) => void;
    isStep: boolean;
    setServerAutomation: (row: any) => void;
    onDryRun: (fromTrigger?: any) => Promise<void>;
    t: (key: string, fallback?: string, vars?: Record<string, unknown>) => string;
    /** The Editor view (BuildTab) while `tab === 'build'`, else false. */
    editor: ReactNode;
    /** The Version history view while `tab === 'versions'`, else false. */
    versions: ReactNode;
    /** The run list once the automation has a server row, else null (the empty state shows). */
    history: ReactNode;
}

/**
 * The builder's chrome: the confirm and AI Act dialogs, the shared header on
 * the non-Editor views, the trigger health panel, Settings, and the slots the
 * other views render into. Split out of BuilderShell, which keeps the state;
 * nothing here owns any.
 */
export default function BuilderShellLayout({
    confirm, confirmDialog, aiActGate, setAiActGate, retryAfterAiAct, serverAutomation, state, tab, setTab,
    headerProps, diagnoseOpen, diagnoseResult, diagnoseLoading, diagnoseError, setDiagnoseOpen, diagnoseAnchorRef,
    onSaveAutomation, settingsSection, workMode, setWorkMode, isStep, setServerAutomation, onDryRun, t,
    editor, versions, history,
}: BuilderShellLayoutProps) {
    return (
        <BuilderConfirmProvider value={confirm}>
        <div className="flex flex-col h-full min-h-0">
            {/* Every confirmation in the builder renders here, in the product's
                own chrome — `window.confirm` put the question in a browser box
                titled "localhost:5176 says". */}
            {confirmDialog}
            {aiActGate && (serverAutomation?.id || state.automationId) && (
                <AiActQuestionsDialog
                    open
                    automationId={serverAutomation?.id || state.automationId}
                    stamp={readinessStamp(serverAutomation)}
                    action={aiActGate.action}
                    onClose={() => setAiActGate(null)}
                    onAnswered={retryAfterAiAct}
                />
            )}
            {/* On Build, BuildTab renders this same header (with the add-step
                ribbon embedded in it); on the other tabs the shell renders it. */}
            {tab !== 'build' && <BuilderHeader {...headerProps} />}

            {diagnoseOpen && (
                <TriggerDiagnosePanel
                    result={diagnoseResult}
                    loading={diagnoseLoading}
                    error={diagnoseError}
                    onClose={() => setDiagnoseOpen(false)}
                    anchorRef={diagnoseAnchorRef}
                />
            )}

            <div className="flex-1 min-h-0 relative">
                {editor}
                {tab === 'settings' && (
                    <SettingsTab
                        automation={serverAutomation}
                        onSave={onSaveAutomation}
                        initialSection={settingsSection}
                        workMode={workMode}
                        onWorkModeChange={isStep ? undefined : setWorkMode}
                        onOpenTab={setTab}
                        onAutomationChange={setServerAutomation}
                    />
                )}
                {/* Its own view rather than the last section of Settings —
                    it needs the room, and buried there nobody found it
                    (BFSF-344). */}
                {versions}
                {/* Mounted HIDDEN rather than conditionally: a run open on the
                    canvas view would otherwise unmount and lose its scroll,
                    zoom and filters every time the user peeks at the Editor.
                    `active` gates fetching/streaming, so the hidden panel
                    costs nothing. */}
                <div className={tab === 'history' ? 'h-full' : 'hidden'}>
                    {history ?? (
                    // Never fire GET /api/automation/null/runs for a draft
                    // that has no server row yet.
                    tab === 'history' && (
                        <div className="h-full flex flex-col items-center justify-center gap-2 px-6 text-center">
                            <div className="text-sm text-[var(--text-primary)] font-medium">{t('automations.builder_shell.this_automation_hasn_t_run_yet', 'This automation hasn\'t run yet.')}</div>
                            <div className="text-xs text-[var(--text-secondary)]">{t('automations.builder_shell.run_a_test_to_see_what', 'Run a test to see what happens, step by step.')}</div>
                            <button
                                type="button"
                                onClick={() => { setTab('build'); onDryRun?.(); }}
                                className="mt-1 inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition"
                            >
                                {t('automations.builder_shell.run_a_test', 'Run a test')}
                            </button>
                        </div>
                    )
                    )}
                </div>
            </div>
        </div>
        </BuilderConfirmProvider>
    );
}
