import { ArrowUp, Loader2 } from 'lucide-react';
import beeFlowIcon from '../../../../assets/BeeFlow-logo-Icon-2026.svg';
import ModelTierSelector from '../../../licensing/ModelTierSelector';
import MarkdownRenderer from '../../../renderers/MarkdownRenderer';
import PlanCard from '../PlanCard';
import RefineDoneCard from './RefineDoneCard';

// De verfijn-rail ("refine this agent") van de builder-split. Sinds A2 stap 1
// staat hij RECHTS in plaats van links: vandaar de linkerrand en de
// ondergrens van 300px (zie useChatPanelResize). De terugpijl is uit deze
// kop verdwenen — die zit nu in de gedeelde AgentEditorHeader, waar hij ook
// staat als de rail verborgen is (alleen-lezen).
// Alle state blijft op de BuilderSplit-fiber en komt via props binnen.
//
// A2 stap 5: een geslaagde verfijning voegt een beurt met `role: 'done'` toe
// (de diff, plus het undo-punt). Alleen de NIEUWSTE daarvan kan ongedaan
// gemaakt worden — undo is één niveau diep — dus de oudere krijgen dezelfde
// knop met de reden erin, niet géén knop.
export default function BuilderChatPanel({ chatWidth, t, chatScrollRef, chat, chatInput, setChatInput, handleRefine, chatBusy, tiers, chatTier, setChatTier, onTestAgent, onUndoRefine }) {
    const lastDoneIndex = chat.reduce((last, m, i) => (m.role === 'done' ? i : last), -1);
    return (
            <aside
                style={{ width: chatWidth }}
                className="flex-shrink-0 border-l border-[var(--border-default)] flex flex-col min-w-[300px] max-w-[600px] bg-[var(--bg-secondary)]"
                data-surface="subtle"
            >
                <div ref={chatScrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
                    {chat.length === 0 && (
                        <div className="h-full flex flex-col items-center justify-center text-center px-3">
                            <img src={beeFlowIcon} alt={t('agent_wizard.builder_chat_bee_flow', 'Bee Flow')} className="w-12 h-12 mb-4" />
                            <div className="text-base font-semibold text-[var(--text-primary)] mb-2">
                                {t('agent_wizard.builder.chat_empty_title', 'Refine this agent with AI')}
                            </div>
                            <div className="text-sm text-[var(--text-secondary)] mb-6 max-w-[280px] leading-relaxed">
                                {t('agent_wizard.builder.chat_empty_subtitle', "Tell me what to change — I'll update the instructions, knowledge, or behaviour.")}
                            </div>
                            <div className="flex flex-col gap-2 w-full max-w-[320px]">
                                {[
                                    'agent_wizard.builder.chat_prompt_tone',
                                    'agent_wizard.builder.chat_prompt_steps',
                                    'agent_wizard.builder.chat_prompt_constraint',
                                ].map((key) => (
                                    <button
                                        key={key}
                                        type="button"
                                        onClick={() => setChatInput(t(key))}
                                        className="text-left text-sm px-4 py-3 rounded-xl border border-[var(--border-default)] bg-[var(--bg-card,#fff)] hover:bg-[var(--bg-secondary)] text-[var(--text-primary)] transition shadow-sm"
                                    >
                                        {t(key)}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                    {chat.map((m, i) => {
                        if (m.role === 'user') {
                            return (
                                <div key={i} className="flex justify-end">
                                    <div className="max-w-[80%] rounded-2xl bg-[var(--user-bubble-bg,#e8e8eb)] px-4 py-2 text-[15px] text-[var(--user-bubble-fg,#000)]">{m.content}</div>
                                </div>
                            );
                        }
                        if (m.role === 'plan') {
                            // Plan card in the chat scrollback is read-only — the agent
                            // already exists, so the Build button would be a no-op.
                            return <div key={i}><PlanCard plan={m.plan} hideActions /></div>;
                        }
                        if (m.role === 'done') {
                            return (
                                <RefineDoneCard
                                    key={i}
                                    t={t}
                                    changes={m.changes}
                                    undoVersionId={m.undoVersionId || null}
                                    undoState={m.undoState || 'idle'}
                                    superseded={i !== lastDoneIndex}
                                    onTest={onTestAgent}
                                    onUndo={(versionId) => onUndoRefine?.(i, versionId)}
                                />
                            );
                        }
                        if (m.role === 'error') {
                            return <div key={i} className="text-xs text-red-500">{m.content}</div>;
                        }
                        if (m.role === 'system') {
                            return (
                                <div key={i} className="text-xs px-3 py-2 rounded-lg bg-[var(--bg-secondary)] text-[var(--text-secondary)] inline-block">
                                    {m.content}
                                </div>
                            );
                        }
                        return (
                            <div key={i} className="text-[15px] leading-7 text-[var(--text-primary)] prose prose-sm max-w-none">
                                <MarkdownRenderer content={m.content || ''} />
                            </div>
                        );
                    })}
                </div>
                <div className="p-3">
                    <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-secondary)] px-4 pt-3 pb-2">
                        <textarea
                            value={chatInput}
                            onChange={(e) => setChatInput(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleRefine(); } }}
                            placeholder={t('agent_wizard.builder.chat_placeholder')}
                            className="w-full bg-transparent outline-none text-sm text-[var(--text-primary)] placeholder-[var(--text-tertiary)] resize-none"
                            rows={1}
                            disabled={chatBusy}
                        />
                        <div className="flex items-center justify-end gap-2 mt-2">
                            <ModelTierSelector
                                tiers={tiers || {}}
                                value={chatTier}
                                onChange={setChatTier}
                                dropDirection="up"
                                variant="input"
                            />
                            <button
                                onClick={handleRefine}
                                disabled={chatBusy || !chatInput.trim()}
                                className="p-2 bg-[var(--text-primary)] text-white rounded-full hover:opacity-90 disabled:opacity-30 disabled:cursor-not-allowed transition-all shadow-sm active:scale-95 transform duration-100"
                                title={t('agent_wizard.builder.send', 'Send')}
                                aria-label={t('agent_wizard.builder.send', 'Send')}
                            >
                                {chatBusy ? <Loader2 className="w-5 h-5 animate-spin" /> : <ArrowUp className="w-5 h-5" />}
                            </button>
                        </div>
                    </div>
                    <div className="text-[11px] text-center text-[var(--text-tertiary)] mt-2">
                        {t('agent_studio.refine.ai_disclaimer', 'AI can make mistakes. Please verify important information.')}
                    </div>
                </div>
            </aside>
    );
}
