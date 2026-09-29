import { getToolLabel, getToolIcon, toolNameToCatalogId } from '../../../utils/helpers';
import AppEmoji from '../../icons/AppEmoji';
import { DurationPill, StepBadge, TimelineRail } from './timelineParts';
import useTranslation from '../../../hooks/useTranslation';

/**
 * Tools Used — vertical timeline inside "How I got this answer".
 * Lifted verbatim out of MessageItem/index.jsx; the caller still owns the
 * `visibleTools.length > 0` gate.
 *
 * Het bolletje, de verbindingslijn en de duurpil staan sinds A4 in
 * `timelineParts.jsx`: het spoorpaneel toont dezelfde soort lijst en moet er
 * dezelfde bolletjes en dezelfde afronding op de duur bij krijgen.
 */
const ToolsUsedTimeline = ({ visibleTools }) => {
    const { t } = useTranslation();
    return (
    <div>
        <div className="text-[10px] font-semibold uppercase tracking-wider mb-2 px-1" style={{ color: 'var(--text-tertiary)' }}>{t('chat.msg.tools_used', 'Tools Used')}</div>
        <div className="relative">
            <TimelineRail show={visibleTools.length > 1} />
            <div className="space-y-2">
            {visibleTools.map((tool, i) => {
                const durationMs = tool.endTime && tool.startTime ? tool.endTime - tool.startTime : null;
                const argEntries = tool.args ? Object.entries(tool.args).filter(([k]) => !k.startsWith('_')) : [];
                const preview = tool.resultPreview ? tool.resultPreview.slice(0, 150) : null;
                return (
                    <details key={i} className="group/tool-step relative flex gap-2.5">
                        <StepBadge n={i + 1} />
                        {/* Card */}
                        <div className="flex-1 min-w-0">
                            <summary className="flex items-center gap-2 cursor-pointer rounded-lg px-2.5 py-2 select-none list-none [&::-webkit-details-marker]:hidden transition-colors hover:bg-[var(--bg-tertiary)]" style={{ background: 'var(--bg-tertiary)', border: '1px solid transparent' }}>
                                <AppEmoji id={toolNameToCatalogId(tool.name)} default={getToolIcon(tool.name)} className="text-sm flex-shrink-0" />
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-1.5 flex-wrap">
                                        <span className="text-[11px] font-semibold" style={{ color: 'var(--text-primary)' }}>{getToolLabel(tool.name)}</span>
                                        {/* Arg chips */}
                                        {argEntries.slice(0, 3).map(([k, v]) => {
                                            const val = typeof v === 'string' ? (v.length > 35 ? v.slice(0, 35) + '…' : v) : JSON.stringify(v).slice(0, 25);
                                            return (
                                                <span key={k} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] max-w-[160px] overflow-hidden" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)' }}>
                                                    <span className="font-medium opacity-50 flex-shrink-0" style={{ color: 'var(--text-secondary)' }}>{k}</span>
                                                    <span className="truncate" style={{ color: 'var(--text-primary)' }}>{val}</span>
                                                </span>
                                            );
                                        })}
                                    </div>
                                </div>
                                <div className="flex items-center gap-1.5 flex-shrink-0">
                                    <DurationPill ms={durationMs} />
                                    {preview && (
                                        <svg className="w-2.5 h-2.5 transition-transform group-open/tool-step:rotate-90 opacity-40" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                                    )}
                                </div>
                            </summary>
                            {/* Result preview */}
                            {preview && (
                                <div className="mt-1 mx-0.5 px-3 py-2 rounded-b-lg text-[10px] leading-relaxed" style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)', borderTop: '1px solid var(--border-subtle)', fontFamily: 'monospace', opacity: 0.85 }}>
                                    <div className="line-clamp-3">{preview}{tool.resultPreview?.length > 150 ? ' …' : ''}</div>
                                </div>
                            )}
                        </div>
                    </details>
                );
            })}
            </div>
        </div>
    </div>
    );
};

export default ToolsUsedTimeline;
