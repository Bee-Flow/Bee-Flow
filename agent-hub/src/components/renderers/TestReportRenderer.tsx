import { CheckCircle, XCircle, AlertTriangle, Clock, ChevronDown, ChevronRight, Bug, Shield, Zap, Eye } from 'lucide-react';
import React, { useState } from 'react';
import MarkdownRenderer from './MarkdownRenderer';
import type { TestCase, TestReportData } from './TestReportRenderer.types';
import { useTranslation } from '../../hooks/useTranslation';

const TestReportRenderer = ({ data }: { data?: TestReportData | null }) => {
    const { t } = useTranslation();
    const [expandedTests, setExpandedTests] = useState(new Set<number>());
    const [filter, setFilter] = useState('all'); // all, passed, failed, warning, skipped

    if (!data) return null;

    const tests = data.tests || [];
    const summary = data.summary || {
        passed: tests.filter((t: TestCase): boolean => t.status === 'passed').length,
        failed: tests.filter((t: TestCase): boolean => t.status === 'failed').length,
        skipped: tests.filter((t: TestCase): boolean => t.status === 'skipped').length,
        warnings: tests.filter((t: TestCase): boolean => t.status === 'warning').length,
    };
    const total = (summary.passed || 0) + (summary.failed || 0) + (summary.skipped || 0) + (summary.warnings || 0);
    const passRate = total > 0 ? Math.round(((summary.passed || 0) / total) * 100) : 0;

    const toggleTest = (index: number) => {
        setExpandedTests(prev => {
            const next = new Set(prev);
            if (next.has(index)) next.delete(index);
            else next.add(index);
            return next;
        });
    };

    const filteredTests = filter === 'all'
        ? tests
        : tests.filter((t: TestCase): boolean => t.status === filter);

    const statusConfig: Record<string, { color: string; bg: string; icon: React.JSX.Element; label: string; }> = {
        passed: { color: '#10b981', bg: 'rgba(16, 185, 129, 0.12)', icon: <CheckCircle className="w-4 h-4" />, label: 'Passed' },
        failed: { color: '#ef4444', bg: 'rgba(239, 68, 68, 0.12)', icon: <XCircle className="w-4 h-4" />, label: 'Failed' },
        warning: { color: '#f59e0b', bg: 'rgba(245, 158, 11, 0.12)', icon: <AlertTriangle className="w-4 h-4" />, label: 'Warning' },
        skipped: { color: '#6b7280', bg: 'rgba(107, 114, 128, 0.12)', icon: <Clock className="w-4 h-4" />, label: 'Skipped' },
    };

    const categoryConfig: Record<string, { icon: React.JSX.Element; color: string; }> = {
        functionality: { icon: <Zap className="w-3.5 h-3.5" />, color: '#818cf8' },
        ui: { icon: <Eye className="w-3.5 h-3.5" />, color: '#38bdf8' },
        performance: { icon: <Clock className="w-3.5 h-3.5" />, color: '#fb923c' },
        accessibility: { icon: <Shield className="w-3.5 h-3.5" />, color: '#a78bfa' },
        security: { icon: <Bug className="w-3.5 h-3.5" />, color: '#f472b6' },
    };

    const severityColors: Record<string, string> = {
        critical: '#ef4444',
        major: '#f97316',
        minor: '#eab308',
        cosmetic: '#6b7280',
    };

    return (
        <div className="w-[100%] max-w-[100%] [overflow:hidden] [white-space:normal] [font-family:var(--font-sans)] [margin:0.5rem_0] [border-radius:1rem] [background:var(--bg-primary,#0a0a1a)] [border:1px_solid_var(--border-subtle,rgba(255,255,255,0.08))] [box-sizing:border-box]">
            {/* ── Header ── */}
            <div style={{
                padding: '1.5rem 1.5rem 1rem',
                borderBottom: '1px solid var(--border-subtle, rgba(255,255,255,0.08))',
                background: passRate >= 80
                    ? 'linear-gradient(135deg, rgba(16, 185, 129, 0.08) 0%, transparent 50%)'
                    : passRate >= 50
                        ? 'linear-gradient(135deg, rgba(245, 158, 11, 0.08) 0%, transparent 50%)'
                        : 'linear-gradient(135deg, rgba(239, 68, 68, 0.08) 0%, transparent 50%)',
                borderRadius: '1rem 1rem 0 0',
            }}>
                <div className="[display:flex] [align-items:center] [gap:0.5rem] [margin-bottom:0.25rem]">
                    <span className="[font-size:1.25rem]">🧪</span>
                    <h2 className="[font-size:1.25rem] [font-weight:700] [color:var(--text-primary,#fff)] [margin:0]">
                        {data.title || 'Test Report'}
                    </h2>
                </div>
                <div className="[display:flex] [flex-wrap:wrap] [gap:1rem] [font-size:0.75rem] [color:var(--text-muted,#888)] [margin-top:0.5rem]">
                    {data.url && <span>🌐 {data.url}</span>}
                    {data.timestamp && <span>📅 {new Date(data.timestamp).toLocaleString()}</span>}
                    {data.duration && <span>⏱ {data.duration}</span>}
                </div>
            </div>

            {/* ── Summary Stats ── */}
            <div className="[display:grid] [grid-template-columns:repeat(5,1fr)] [gap:0.5rem] [padding:1rem_1.5rem] [border-bottom:1px_solid_var(--border-subtle,rgba(255,255,255,0.08))]">
                {/* Pass rate */}
                <div className="[text-align:center] [padding:0.75rem_0.5rem] [border-radius:0.75rem] [background:var(--bg-tertiary,rgba(255,255,255,0.03))]">
                    <div style={{
                        fontSize: '1.5rem',
                        fontWeight: '800',
                        color: passRate >= 80 ? '#10b981' : passRate >= 50 ? '#f59e0b' : '#ef4444',
                        lineHeight: 1.2,
                    }}>
                        {passRate}%
                    </div>
                    <div className="[font-size:0.65rem] [color:var(--text-muted,#888)] [margin-top:0.25rem] [font-weight:600] [text-transform:uppercase] [letter-spacing:0.5px]">
                        {t('chat.renderers.tests_pass_rate', 'Pass Rate')}
                    </div>
                </div>
                {/* Individual counts */}
                {[
                    { key: 'passed', val: summary.passed || 0 },
                    { key: 'failed', val: summary.failed || 0 },
                    { key: 'warning', val: summary.warnings || 0 },
                    { key: 'skipped', val: summary.skipped || 0 },
                ].map(({ key, val }) => {
                    const sc = statusConfig[key];
                    return (
                        <button
                            key={key}
                            onClick={() => setFilter(filter === key ? 'all' : key)}
                            style={{
                                textAlign: 'center',
                                padding: '0.75rem 0.5rem',
                                borderRadius: '0.75rem',
                                background: filter === key ? sc.bg : 'var(--bg-tertiary, rgba(255,255,255,0.03))',
                                border: filter === key ? `1px solid ${sc.color}40` : '1px solid transparent',
                                cursor: 'pointer',
                                transition: 'all 0.15s ease',
                            }}
                        >
                            <div style={{
                                fontSize: '1.5rem',
                                fontWeight: '800',
                                color: sc.color,
                                lineHeight: 1.2,
                            }}>
                                {val}
                            </div>
                            <div className="[font-size:0.65rem] [color:var(--text-muted,#888)] [margin-top:0.25rem] [font-weight:600] [text-transform:uppercase] [letter-spacing:0.5px]">
                                {sc.label}
                            </div>
                        </button>
                    );
                })}
            </div>

            {/* ── Test Cases ── */}
            <div className="[padding:0.75rem_1.5rem_1rem]">
                {filteredTests.length === 0 && (
                    <div className="[text-align:center] [padding:2rem] [color:var(--text-muted,#888)] [font-size:0.85rem]">
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
                                <span className="[color:var(--text-muted,#888)] [flex-shrink:0]">
                                    {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                                </span>
                                {/* Status icon */}
                                <span style={{ color: sc.color, flexShrink: 0 }}>{sc.icon}</span>
                                {/* Test name */}
                                <span className="[flex:1] [font-size:0.85rem] [font-weight:500] [color:var(--text-primary,#fff)] [overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap]">
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
                                    <span className="[font-size:0.7rem] [color:var(--text-muted,#666)] [flex-shrink:0]">
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
                                        <div className="[font-size:0.8rem] [color:var(--text-secondary,#ccc)] [margin-bottom:0.75rem] [line-height:1.5]">
                                            {test.description}
                                        </div>
                                    )}

                                    {/* Steps */}
                                    {test.steps && test.steps.length > 0 && (
                                        <div className="[margin-bottom:0.75rem]">
                                            <div className="[font-size:0.7rem] [font-weight:600] [color:var(--text-muted,#888)] [text-transform:uppercase] [letter-spacing:0.5px] [margin-bottom:0.4rem]">
                                                {t('chat.renderers.tests_steps', 'Steps')}
                                            </div>
                                            <ol className="[margin:0] [padding-left:1.25rem] [font-size:0.78rem] [color:var(--text-secondary,#ccc)] [line-height:1.8]">
                                                {test.steps.map((step, si) => (
                                                    <li key={si}>{typeof step === 'string' ? step : (step?.description || step?.action || JSON.stringify(step))}</li>
                                                ))}
                                            </ol>
                                        </div>
                                    )}

                                    {/* Error */}
                                    {test.error && (
                                        <div className="[padding:0.6rem_0.75rem] [border-radius:0.5rem] [background:rgba(239,68,68,0.1)] [border:1px_solid_rgba(239,68,68,0.2)] [margin-bottom:0.75rem]">
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
                                                className="max-w-[100%] max-h-[300px] [border-radius:0.5rem] [border:1px_solid_var(--border-subtle,rgba(255,255,255,0.1))] [object-fit:contain]"
                                            />
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>

            {/* ── Recommendations ── */}
            {data.recommendations && data.recommendations.length > 0 && (
                <div className="[padding:1rem_1.5rem] [border-top:1px_solid_var(--border-subtle,rgba(255,255,255,0.08))]">
                    <div className="[font-size:0.8rem] [font-weight:700] [color:var(--text-primary,#fff)] [margin-bottom:0.5rem] [display:flex] [align-items:center] [gap:0.4rem]">
                        💡 {t('chat.renderers.tests_recommendations', 'Recommendations')}
                    </div>
                    <ul className="[margin:0] [padding-left:1.25rem] [font-size:0.8rem] [color:var(--text-secondary,#ccc)] [line-height:1.8]">
                        {data.recommendations.map((rec, i) => (
                            <li key={i}>{typeof rec === 'string' ? rec : (rec?.description || rec?.action || JSON.stringify(rec))}</li>
                        ))}
                    </ul>
                </div>
            )}

            {/* ── Notes ── */}
            {data.notes && (
                <div className="[padding:1rem_1.5rem] [border-top:1px_solid_var(--border-subtle,rgba(255,255,255,0.08))] [font-size:0.8rem] [color:var(--text-secondary,#ccc)] [line-height:1.6]">
                    <MarkdownRenderer content={data.notes} />
                </div>
            )}
        </div>
    );
};

export default TestReportRenderer;
