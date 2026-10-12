import React, { useMemo, useState } from "react";
import { useTranslation } from "../../../hooks/useTranslation";
import MarkdownRenderer from "../../renderers/MarkdownRenderer";
import {
  Activity,
  Cpu,
  Zap,
  Clock,
  Wrench,
  BarChart3,
  RefreshCw,
  TrendingUp,
  Users,
  DollarSign,
  ChevronRight,
  Globe,
  Bot,
  ArrowUp,
  ArrowDown,
  Minus,
  Layers,
  MessageSquare,
  ThumbsUp,
  ThumbsDown,
} from "lucide-react";
import {
  fmt,
  fmtCost,
  fmtDuration,
  fmtTime,
  rowCost,
  COLORS,
  AGENT_COLORS,
  getAgentStyle,
  MODEL_COLORS,
  MetricCard,
  Card,
  Empty,
  ModelRow,
  AgentRow,
} from "./shared";

export function DetailDrawer({
  detail,
  modelCosts,
  costPerModel,
  recent,
  onClose,
}) {
  const { t } = useTranslation();
  const { type, data } = detail;

  // Get recent calls related to this item
  const relatedCalls = useMemo(() => {
    if (type === "model") {
      return recent.filter((r) => r.model === data.model).slice(0, 20);
    }
    if (type === "agent") {
      return recent
        .filter((r) => r.agent_name === data.agent_name)
        .slice(0, 20);
    }
    return [];
  }, [type, data, recent]);

  const overlayStyle = {
    position: "fixed",
    inset: 0,
    zIndex: 1000,
    background: "rgba(0,0,0,0.6)",
    backdropFilter: "blur(4px)",
    animation: "fadeIn 0.2s ease",
  };

  const drawerStyle = {
    position: "fixed",
    top: 0,
    right: 0,
    bottom: 0,
    width: "480px",
    maxWidth: "90vw",
    zIndex: 1001,
    background: "var(--bg-primary, #0f0f1a)",
    borderLeft: "1px solid var(--border-default, rgba(255,255,255,0.08))",
    display: "flex",
    flexDirection: "column",
    animation: "slideInRight 0.25s cubic-bezier(0.4, 0, 0.2, 1)",
  };

  const headerStyle = {
    padding: "20px 24px",
    borderBottom: "1px solid var(--border-default, rgba(255,255,255,0.08))",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  };

  const statGridStyle = {
    display: "grid",
    gridTemplateColumns: "1fr 1fr 1fr",
    gap: "12px",
    padding: "16px 24px",
  };

  const statBoxStyle = {
    padding: "14px",
    borderRadius: "12px",
    background: "var(--bg-secondary, #1a1a2e)",
    border: "1px solid var(--border-default, rgba(255,255,255,0.06))",
    textAlign: "center",
  };

  return (
    <>
      <div style={overlayStyle} onClick={onClose} />
      <div style={drawerStyle}>
        {/* Header */}
        <div style={headerStyle}>
          <div>
            <div
              style={{
                fontSize: "10px",
                fontWeight: 600,
                color: COLORS.primary,
                textTransform: "uppercase",
                letterSpacing: "0.1em",
                marginBottom: "4px",
              }}
            >
              {type === "model" ? "Model Details" : "Agent Details"}
            </div>
            <div
              style={{
                fontSize: "18px",
                fontWeight: 700,
                color: "var(--text-primary, #fff)",
              }}
            >
              {type === "model" ? data.model : data.agent_name || "Unknown"}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              width: "32px",
              height: "32px",
              borderRadius: "8px",
              border: "1px solid var(--border-default, rgba(255,255,255,0.1))",
              background: "var(--bg-tertiary, #222)",
              color: "var(--text-muted, #888)",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "16px",
            }}
          >
            ×
          </button>
        </div>

        {/* Stats */}
        <div style={statGridStyle}>
          <div style={statBoxStyle}>
            <div
              style={{
                fontSize: "22px",
                fontWeight: 800,
                color: "var(--text-primary, #fff)",
              }}
            >
              {fmt(data.calls || 0)}
            </div>
            <div
              style={{
                fontSize: "10px",
                color: "var(--text-muted, #888)",
                marginTop: "2px",
              }}
            >
              {t('admin_monitoring.drawer_calls', 'Calls')}
            </div>
          </div>
          <div style={statBoxStyle}>
            <div
              style={{ fontSize: "22px", fontWeight: 800, color: COLORS.green }}
            >
              {fmt(data.total_tokens || 0)}
            </div>
            <div
              style={{
                fontSize: "10px",
                color: "var(--text-muted, #888)",
                marginTop: "2px",
              }}
            >
              {t('admin_monitoring.drawer_total_tokens', 'Total Tokens')}
            </div>
          </div>
          <div style={statBoxStyle}>
            {(() => {
              const billed = Number(data.billed_cost || 0);
              const raw = type === "model" && costPerModel[data.model]
                ? costPerModel[data.model]
                : (data.estimated_cost || 0);
              const isPayg = billed > 0;
              return (
                <>
                  <div style={{ fontSize: "22px", fontWeight: 800, color: isPayg ? COLORS.green : COLORS.amber }}>
                    {fmtCost(isPayg ? billed : raw)}
                  </div>
                  <div style={{ fontSize: "10px", color: "var(--text-muted, #888)", marginTop: "2px" }}>
                    {isPayg ? `Billed (raw ${fmtCost(raw)})` : "Est. Cost"}
                  </div>
                </>
              );
            })()}
          </div>
        </div>

        {/* Token breakdown */}
        <div style={{ padding: "0 24px 16px" }}>
          <div
            style={{
              padding: "16px",
              borderRadius: "12px",
              background: "var(--bg-secondary, #1a1a2e)",
              border: "1px solid var(--border-default, rgba(255,255,255,0.06))",
            }}
          >
            <div
              style={{
                fontSize: "11px",
                fontWeight: 600,
                color: "var(--text-muted, #888)",
                marginBottom: "12px",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
              }}
            >
              {t('admin_monitoring.drawer_breakdown', 'Breakdown')}
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                marginBottom: "8px",
              }}
            >
              <span
                style={{
                  fontSize: "12px",
                  color: "var(--text-secondary, #aaa)",
                }}
              >
                {t('admin_monitoring.drawer_input_tokens', 'Input tokens')}
              </span>
              <span
                style={{
                  fontSize: "13px",
                  fontWeight: 600,
                  color: COLORS.blue,
                }}
              >
                {fmt(data.prompt_tokens || 0)}
              </span>
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                marginBottom: "8px",
              }}
            >
              <span
                style={{
                  fontSize: "12px",
                  color: "var(--text-secondary, #aaa)",
                }}
              >
                {t('admin_monitoring.drawer_output_tokens', 'Output tokens')}
              </span>
              <span
                style={{
                  fontSize: "13px",
                  fontWeight: 600,
                  color: COLORS.amber,
                }}
              >
                {fmt(data.completion_tokens || 0)}
              </span>
            </div>
            {type === "model" && modelCosts[data.model] && (
              <>
                <div
                  style={{
                    borderTop:
                      "1px solid var(--border-default, rgba(255,255,255,0.06))",
                    margin: "10px 0",
                  }}
                />
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    marginBottom: "6px",
                  }}
                >
                  <span
                    style={{
                      fontSize: "12px",
                      color: "var(--text-secondary, #aaa)",
                    }}
                  >
                    {t('admin_monitoring.drawer_input_rate', 'Input rate')}
                  </span>
                  <span
                    style={{
                      fontSize: "12px",
                      color: "var(--text-muted, #888)",
                    }}
                  >
                    {t('admin_monitoring.drawer_rate_in', '{price}/1M tokens', { price: `$${modelCosts[data.model].input}` })}
                  </span>
                </div>
                <div
                  style={{ display: "flex", justifyContent: "space-between" }}
                >
                  <span
                    style={{
                      fontSize: "12px",
                      color: "var(--text-secondary, #aaa)",
                    }}
                  >
                    {t('admin_monitoring.drawer_output_rate', 'Output rate')}
                  </span>
                  <span
                    style={{
                      fontSize: "12px",
                      color: "var(--text-muted, #888)",
                    }}
                  >
                    {t('admin_monitoring.drawer_rate_out', '{price}/1M tokens', { price: `$${modelCosts[data.model].output}` })}
                  </span>
                </div>
              </>
            )}
            {type === "agent" && data.agent_type && (
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span
                  style={{
                    fontSize: "12px",
                    color: "var(--text-secondary, #aaa)",
                  }}
                >
                  {t('admin_monitoring.drawer_agent_type', 'Agent type')}
                </span>
                <span
                  style={{
                    padding: "2px 8px",
                    borderRadius: "4px",
                    fontSize: "11px",
                    fontWeight: 600,
                    background: getAgentStyle(data.agent_type).bg,
                    color: getAgentStyle(data.agent_type).text,
                  }}
                >
                  {data.agent_type}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Related calls */}
        <div style={{ flex: 1, overflow: "auto", padding: "0 24px 24px" }}>
          <div
            style={{
              fontSize: "11px",
              fontWeight: 600,
              color: "var(--text-muted, #888)",
              marginBottom: "10px",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            {t('admin_monitoring.drawer_recent_calls', 'Recent Calls ({n})', { n: relatedCalls.length })}
          </div>
          {relatedCalls.length === 0 ? (
            <div
              style={{
                fontSize: "12px",
                color: "var(--text-muted, #666)",
                textAlign: "center",
                padding: "20px",
              }}
            >
              {t('admin_monitoring.drawer_no_recent', 'No recent calls found')}
            </div>
          ) : (
            <div
              style={{ display: "flex", flexDirection: "column", gap: "6px" }}
            >
              {relatedCalls.map((r, i) => {
                const c = modelCosts[r.model];
                const cost = rowCost(r, c);
                return (
                  <div
                    key={i}
                    style={{
                      padding: "10px 12px",
                      borderRadius: "8px",
                      background: "var(--bg-secondary, #1a1a2e)",
                      border:
                        "1px solid var(--border-default, rgba(255,255,255,0.06))",
                      fontSize: "11px",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        marginBottom: "4px",
                      }}
                    >
                      <span style={{ color: "var(--text-muted, #888)" }}>
                        {fmtTime(r.timestamp)}
                      </span>
                      <span style={{ color: COLORS.amber, fontWeight: 600 }}>
                        {cost != null ? fmtCost(cost) : "—"}
                      </span>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        gap: "12px",
                        color: "var(--text-secondary, #aaa)",
                      }}
                    >
                      {type !== "model" && <span>{r.model || "—"}</span>}
                      {type !== "agent" && <span>{r.agent_name || "—"}</span>}
                      <span style={{ color: COLORS.blue }}>
                        {t('admin_monitoring.drawer_in_n', '{n} in', { n: fmt(r.prompt_tokens) })}
                      </span>
                      <span style={{ color: COLORS.amber }}>
                        {t('admin_monitoring.drawer_out_n', '{n} out', { n: fmt(r.completion_tokens) })}
                      </span>
                      <span style={{ color: "var(--text-muted, #666)" }}>
                        {fmtDuration(r.duration_ms)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <style>{`
                @keyframes slideInRight {
                    from { transform: translateX(100%); }
                    to { transform: translateX(0); }
                }
            `}</style>
    </>
  );
}
