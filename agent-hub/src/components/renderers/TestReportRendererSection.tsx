import { ChevronDown, ChevronRight } from 'lucide-react';
import React from 'react';
import type { TestCase } from './TestReportRenderer.types';
import { TranslateParams } from '../../hooks/useTranslation';

export function TestReportRendererSection({ filteredTests, filter, t, statusConfig, categoryConfig, expandedTests, severityColors, toggleTest }: { filteredTests: TestCase[]; filter: string; t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; statusConfig: Record<string, { color: string; bg: string; icon: React.JSX.Element; label: string; }>; categoryConfig: Record<string, { icon: React.JSX.Element; color: string; }>; expandedTests: Set<number>; severityColors: Record<string, string>; toggleTest: (index: number) => void; }) {
    return <div className="[padding:0.75rem_1.5rem_1rem]">
        {filteredTests.length === 0 && (
            <div className="[text-align:center] [padding:2rem] [color:var(--text-muted,_#888)] [font-size:0.85rem]">
                {filter !== 'all' ? t('chat.renderers.tests_none_filtered', 'No {filter} tests to display', { filter }) : t('chat.renderers.tests_none', 'No tests to display')}
            </div>
        )}
        {filteredTests.map((test, i) => {
            const sc = statusConfig[test.status] || statusConfig.skipped;
            const cat = categoryConfig[test.category];
            const isExpanded = expandedTests.has(i);
            const sev = test.severity ? severityColors[test.severity] : null;

            return (
                <div key={i} style={{
                    marginBottom: '0.5rem',
                    borderRadius: '0.75rem',
                    border: `1px solid ${isExpanded ? sc.color + '30' : 'var(--border-subtle, rgba(255,255,255,0.06))'}`,
                    overflow: 'hidden',
                    transition: 'all 0.15s ease',
                }}>
                    {/* Test header row */}
                    <button
                        onClick={() => toggleTest(i)}
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.75rem',
                            width: '100%',
                            padding: '0.75rem 1rem',
                            background: isExpanded ? sc.bg : 'transparent',
                            border: 'none',
                            cursor: 'pointer',
                            textAlign: 'left',
                            transition: 'background 0.15s ease',
                        }}
                    >
                        {/* Expand chevron */}
                        <span className="[color:var(--text-muted,_#888)] [flex-shrink:0]">
                            {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                        </span>
                        {/* Status icon */}
                        <span style={{ color: sc.color, flexShrink: 0 }}>{sc.icon}</span>
                        {/* Test name */}
                        <span className="[flex:1] [font-size:0.85rem] [font-weight:500] [color:var(--text-primary,_#fff)] [overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap]">
                            {test.name}
                        </span>
                        {/* Category badge */}
                        {cat && (
                            <span style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '0.25rem',
                                fontSize: '0.65rem',
                                fontWeight: '600',
                                color: cat.color,
                                background: cat.color + '18',
                                padding: '0.2rem 0.5rem',
                                borderRadius: '999px',
                                flexShrink: 0,
                            }}>
                                {cat.icon} {test.category}
                            </span>
                        )}
                        {/* Severity badge */}
                        {sev && (
                            <span style={{
                                fontSize: '0.6rem',
                                fontWeight: '700',
                                color: sev,
                                textTransform: 'uppercase',
                                letterSpacing: '0.5px',
                                flexShrink: 0,
                            }}>
                                {test.severity}
                            </span>
                        )}
                        {/* Duration */}
                        {test.duration && (
                            <span className="[font-size:0.7rem] [color:var(--text-muted,_#666)] [flex-shrink:0]">
                                {test.duration}
                            </span>
                        )}
                    </button>

                    {/* Expanded details */}
                    {isExpanded && (
                        <div style={{
                            padding: '0.75rem 1rem 1rem',
                            paddingLeft: '3rem',
                            background: sc.bg,
                            borderTop: `1px solid ${sc.color}15`,
                        }}>
                            {/* Description */}
                            {test.description && (
                                <div className="[font-size:0.8rem] [color:var(--text-secondary,_#ccc)] [margin-bottom:0.75rem] [line-height:1.5]">
                                    {test.description}
                                </div>
                            )}

                            {/* Steps */}
                            {test.steps && test.steps.length > 0 && (
                                <div className="[margin-bottom:0.75rem]">
                                    <div className="[font-size:0.7rem] [font-weight:600] [color:var(--text-muted,_#888)] [text-transform:uppercase] [letter-spacing:0.5px] [margin-bottom:0.4rem]">
                                        {t('chat.renderers.tests_steps', 'Steps')}
                                    </div>
                                    <ol className="[margin:0] [padding-left:1.25rem] [font-size:0.78rem] [color:var(--text-secondary,_#ccc)] [line-height:1.8]">
                                        {test.steps.map((step, si) => (
                                            <li key={si}>{typeof step === 'string' ? step : (step?.description || step?.action || JSON.stringify(step))}</li>
                                        ))}
                                    </ol>
                                </div>
                            )}

                            {/* Error */}
                            {test.error && (
                                <div className="[padding:0.6rem_0.75rem] [border-radius:0.5rem] [background:rgba(239,_68,_68,_0.1)] [border:1px_solid_rgba(239,_68,_68,_0.2)] [margin-bottom:0.75rem]">
                                    <div className="[font-size:0.7rem] [font-weight:600] [color:#ef4444] [margin-bottom:0.25rem]">
                                        ❌ {t('chat.renderers.tests_error', 'Error')}
                                    </div>
                                    <div className="[font-size:0.78rem] [color:#fca5a5] [font-family:monospace] [white-space:pre-wrap] [word-break:break-word]">
                                        {test.error}
                                    </div>
                                </div>
                            )}

                            {/* Screenshot */}
                            {test.screenshot && (
                                <div className="[margin-bottom:0.5rem]">
                                    <img
                                        src={test.screenshot}
                                        alt={`Screenshot: ${test.name}`}
                                        className="[max-width:100%] [max-height:300px] [border-radius:0.5rem] [border:1px_solid_var(--border-subtle,_rgba(255,255,255,0.1))] [object-fit:contain]" />
                                </div>
                            )}
                        </div>
                    )}
                </div>
            );
        })}
    </div>;
}
