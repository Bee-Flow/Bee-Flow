import { ChevronDown, ChevronRight } from 'lucide-react';
import React from 'react';
import type { TestCase } from './TestReportRenderer.types';
import { TranslateParams } from '../../hooks/useTranslation';

export function TestReportRendererSection({ filteredTests, filter, t, statusConfig, categoryConfig, expandedTests, severityColors, toggleTest }: { filteredTests: TestCase[]; filter: string; t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; statusConfig: Record<string, { color: string; bg: string; icon: React.JSX.Element; label: string; }>; categoryConfig: Record<string, { icon: React.JSX.Element; color: string; }>; expandedTests: Set<number>; severityColors: Record<string, string>; toggleTest: (index: number) => void; }) {
    return <div style={{ padding: '0.75rem 1.5rem 1rem' }}>
        {filteredTests.length === 0 && (
            <div style={{
                textAlign: 'center',
                padding: '2rem',
                color: 'var(--text-muted, #888)',
                fontSize: '0.85rem',
            }}>
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
                        <span style={{ color: 'var(--text-muted, #888)', flexShrink: 0 }}>
                            {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                        </span>
                        {/* Status icon */}
                        <span style={{ color: sc.color, flexShrink: 0 }}>{sc.icon}</span>
                        {/* Test name */}
                        <span style={{
                            flex: 1,
                            fontSize: '0.85rem',
                            fontWeight: '500',
                            color: 'var(--text-primary, #fff)',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                        }}>
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
                            <span style={{
                                fontSize: '0.7rem',
                                color: 'var(--text-muted, #666)',
                                flexShrink: 0,
                            }}>
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
                                <div style={{
                                    fontSize: '0.8rem',
                                    color: 'var(--text-secondary, #ccc)',
                                    marginBottom: '0.75rem',
                                    lineHeight: 1.5,
                                }}>
                                    {test.description}
                                </div>
                            )}

                            {/* Steps */}
                            {test.steps && test.steps.length > 0 && (
                                <div style={{ marginBottom: '0.75rem' }}>
                                    <div style={{
                                        fontSize: '0.7rem',
                                        fontWeight: '600',
                                        color: 'var(--text-muted, #888)',
                                        textTransform: 'uppercase',
                                        letterSpacing: '0.5px',
                                        marginBottom: '0.4rem',
                                    }}>
                                        {t('chat.renderers.tests_steps', 'Steps')}
                                    </div>
                                    <ol style={{
                                        margin: 0,
                                        paddingLeft: '1.25rem',
                                        fontSize: '0.78rem',
                                        color: 'var(--text-secondary, #ccc)',
                                        lineHeight: 1.8,
                                    }}>
                                        {test.steps.map((step, si) => (
                                            <li key={si}>{typeof step === 'string' ? step : (step?.description || step?.action || JSON.stringify(step))}</li>
                                        ))}
                                    </ol>
                                </div>
                            )}

                            {/* Error */}
                            {test.error && (
                                <div style={{
                                    padding: '0.6rem 0.75rem',
                                    borderRadius: '0.5rem',
                                    background: 'rgba(239, 68, 68, 0.1)',
                                    border: '1px solid rgba(239, 68, 68, 0.2)',
                                    marginBottom: '0.75rem',
                                }}>
                                    <div style={{
                                        fontSize: '0.7rem',
                                        fontWeight: '600',
                                        color: '#ef4444',
                                        marginBottom: '0.25rem',
                                    }}>
                                        ❌ {t('chat.renderers.tests_error', 'Error')}
                                    </div>
                                    <div style={{
                                        fontSize: '0.78rem',
                                        color: '#fca5a5',
                                        fontFamily: 'monospace',
                                        whiteSpace: 'pre-wrap',
                                        wordBreak: 'break-word',
                                    }}>
                                        {test.error}
                                    </div>
                                </div>
                            )}

                            {/* Screenshot */}
                            {test.screenshot && (
                                <div style={{ marginBottom: '0.5rem' }}>
                                    <img
                                        src={test.screenshot}
                                        alt={`Screenshot: ${test.name}`}
                                        style={{
                                            maxWidth: '100%',
                                            maxHeight: '300px',
                                            borderRadius: '0.5rem',
                                            border: '1px solid var(--border-subtle, rgba(255,255,255,0.1))',
                                            objectFit: 'contain',
                                        }} />
                                </div>
                            )}
                        </div>
                    )}
                </div>
            );
        })}
    </div>;
}
