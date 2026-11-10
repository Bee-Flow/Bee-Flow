import type { ReactNode } from 'react';
import SectionHeader from '@/components/shared/SectionHeader';
import { FIELD_INPUT, Field, SettingBlock, SettingsGroup, SettingsList } from '@/components/shared/SettingsList';
import { SECONDARY_BTN } from '@/components/mcpLibrary/ui';
import Toggle from '@/components/shared/Toggle';
import useCopyToClipboard from '@/hooks/useCopyToClipboard';
import { useTranslation } from '@/hooks/useTranslation';
import type { DesignerSectionProps } from './sectionProps';
import { widgetSnippet, type WidgetOptions } from './embedSnippet';

const MONO_INPUT = `${FIELD_INPUT} font-mono text-xs`;
const RANGE = 'w-full accent-[var(--accent-primary)]';
const SEGMENT_ON = 'flex-1 rounded-md border border-[var(--accent-primary)] bg-[var(--bg-tertiary)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] transition-colors';
const SEGMENT_OFF = 'flex-1 rounded-md border border-[var(--border-default)] px-3 py-1.5 text-xs text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-secondary)]';
const FONTS: [string, string][] = [
  ['System Default', 'agent_studio.behavior_system_default'], ['Inter', 'agent_studio.behavior_inter'],
  ['Roboto', 'agent_studio.behavior_roboto'], ['Open Sans', 'agent_studio.behavior_open_sans'],
  ['Lato', 'agent_studio.behavior_lato'], ['Poppins', 'agent_studio.behavior_poppins'],
  ['Nunito', 'agent_studio.behavior_nunito'], ['Georgia', 'agent_studio.behavior_georgia'],
  ['Courier New', 'agent_studio.behavior_courier_new'],
];

/** A read-only value with a Copy button next to it (public URL, iframe tag, widget code). */
function CopyField({ id, value, onCopy, multiline }: { id: string; value: string; onCopy: () => void; multiline?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-start gap-2">
      {multiline
        ? <textarea id={id} readOnly rows={3} value={value} className={`${MONO_INPUT} flex-1 resize-none text-[var(--text-secondary)]`} />
        : <input id={id} readOnly value={value} className={`${MONO_INPUT} flex-1 text-[var(--text-secondary)]`} />}
      <button type="button" onClick={onCopy} className={SECONDARY_BTN}>{t('agent_studio.behavior_copy', 'Copy')}</button>
    </div>
  );
}

/** A colour picker with the same value as text: the picker shows `fallback` while the value is empty. */
function ColorField({ id, label, value, fallback, onChange, placeholder }: { id: string; label: string; value: string; fallback?: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <Field label={label} htmlFor={id}>
      <div className="flex items-center gap-2">
        <input type="color" aria-label={label} value={value || fallback} onChange={(e) => onChange(e.target.value)} className="h-8 w-8 shrink-0 cursor-pointer rounded-md border border-[var(--border-default)] bg-transparent p-0" />
        <input id={id} type="text" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={MONO_INPUT} />
      </div>
    </Field>
  );
}

/** A labelled slider. */
function RangeField({ id, label, value, onChange, min, max, step }: { id: string; label: ReactNode; value: number; onChange: (v: number) => void; min: number; max: number; step?: number }) {
  return (
    <Field label={label} htmlFor={id}>
      <input id={id} type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className={RANGE} />
    </Field>
  );
}

/** Look and size of the floating bubble and its chat window. */
function BubbleLookFields(p: DesignerSectionProps) {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <ColorField id="embed-bubble-color" label={t('agent_studio.behavior_bubble_color', 'Bubble Color')} value={p.bubbleColor} onChange={p.setBubbleColor} />
      <Field label={t('agent_studio.behavior_position', 'Position')}>
        <div className="flex gap-1">
          {['left', 'right'].map(pos => (
            <button key={pos} type="button" aria-pressed={p.bubblePosition === pos} onClick={() => p.setBubblePosition(pos)} className={p.bubblePosition === pos ? SEGMENT_ON : SEGMENT_OFF}>
              {pos === 'left' ? t('agent_studio.behavior_position_left', '◀ Left') : t('agent_studio.behavior_position_right', 'Right ▶')}
            </button>
          ))}
        </div>
      </Field>
      <RangeField id="embed-bubble-size" label={t('agent_studio.behavior_bubble_size_bubble_sizepx', 'Bubble Size: {bubble_size}px', { bubble_size: p.bubbleSize })} value={p.bubbleSize} onChange={p.setBubbleSize} min={40} max={80} />
      <Field label={t('agent_studio.behavior_icon', 'Icon')}>
        <div className="flex gap-1">
          {['🐝', '💬', '🤖', '❓', '👋'].map(icon => (
            <button
              key={icon}
              type="button"
              aria-pressed={p.bubbleIcon === icon}
              onClick={() => p.setBubbleIcon(icon)}
              className={`flex h-8 w-8 items-center justify-center rounded-md text-base transition-colors ${p.bubbleIcon === icon ? 'bg-[var(--bg-tertiary)] ring-2 ring-[var(--accent-primary)]' : 'bg-[var(--bg-secondary)] hover:bg-[var(--bg-tertiary)]'}`}
            >
              {icon}
            </button>
          ))}
        </div>
      </Field>
      <RangeField id="embed-window-width" label={t('agent_studio.behavior_window_width_window_widthpx', 'Window Width: {window_width}px', { window_width: p.windowWidth })} value={p.windowWidth} onChange={p.setWindowWidth} min={320} max={500} step={10} />
      <RangeField id="embed-window-height" label={t('agent_studio.behavior_window_height_window_heightpx', 'Window Height: {window_height}px', { window_height: p.windowHeight })} value={p.windowHeight} onChange={p.setWindowHeight} min={400} max={800} step={10} />
    </div>
  );
}

/** Font, colours and disclaimer of the chat window inside the bubble. */
function ChatLookFields(p: DesignerSectionProps) {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field label={t('agent_studio.behavior_font_family', 'Font Family')} htmlFor="embed-font">
        <select id="embed-font" value={p.chatFont} onChange={(e) => p.setChatFont(e.target.value)} className={`${FIELD_INPUT} cursor-pointer text-xs`}>
          {FONTS.map(([value, key]) => <option key={value} value={value}>{t(key, value)}</option>)}
        </select>
      </Field>
      <RangeField id="embed-font-size" label={t('agent_studio.behavior_font_size_chat_font_sizepx', 'Font Size: {chat_font_size}px', { chat_font_size: p.chatFontSize })} value={p.chatFontSize} onChange={p.setChatFontSize} min={12} max={20} />
      <RangeField id="embed-line-height" label={t('agent_studio.behavior_line_height', 'Line Height: {value}', { value: p.chatLineHeight })} value={p.chatLineHeight} onChange={p.setChatLineHeight} min={1.2} max={2.0} step={0.1} />
      <div className="hidden sm:block" />
      <ColorField id="embed-user-color" label={t('agent_studio.behavior_user_bubble_color', 'User Bubble Color')} value={p.userBubbleColor} fallback="#6366f1" onChange={p.setUserBubbleColor} placeholder={t('agent_studio.behavior_default', 'Default')} />
      <ColorField id="embed-assistant-color" label={t('agent_studio.behavior_assistant_bubble_color', 'Assistant Bubble Color')} value={p.assistantBubbleColor} fallback="#374151" onChange={p.setAssistantBubbleColor} placeholder={t('agent_studio.behavior_default', 'Default')} />
      <div className="sm:col-span-2">
        <Field label={t('agent_studio.behavior_disclaimer_text', 'Disclaimer Text')} htmlFor="embed-disclaimer">
          <input
            id="embed-disclaimer"
            type="text"
            value={p.warningText}
            onChange={(e) => p.setWarningText(e.target.value)}
            placeholder={t('agent_studio.behavior_ai_can_make_mistakes_please_verify', 'AI can make mistakes. Please verify important information.')}
            className={`${FIELD_INPUT} text-xs`}
          />
        </Field>
      </div>
    </div>
  );
}

/** The public URL, the iframe tag and the chat bubble widget of a published agent. */
function EmbedSettings(p: DesignerSectionProps & { agentId: string }) {
  const { t } = useTranslation();
  const { copy } = useCopyToClipboard();
  const origin = window.location.origin;
  const publicUrl = `${origin}/chat/${p.agentId}`;
  const iframe = `<iframe src="${publicUrl}" width="400" height="600" style="border:none;border-radius:12px;"></iframe>`;
  const widget: WidgetOptions = {
    agentId: p.agentId, origin, bubbleColor: p.bubbleColor, bubblePosition: p.bubblePosition, bubbleSize: p.bubbleSize,
    bubbleIcon: p.bubbleIcon, windowWidth: p.windowWidth, windowHeight: p.windowHeight, chatFont: p.chatFont,
    chatFontSize: p.chatFontSize, chatLineHeight: p.chatLineHeight, userBubbleColor: p.userBubbleColor,
    assistantBubbleColor: p.assistantBubbleColor, warningText: p.warningText,
  };
  const previewSize = Math.min(p.bubbleSize, 50);
  return (
    <>
      <SettingsGroup
        title={t('agent_studio.behavior_embed_settings', 'Embed Settings')}
        description={t('agent_studio.behavior_agent_must_be_published_for_the_embed', 'Agent must be Published for the embed link to work.')}
      >
        <SettingsList>
          <SettingBlock htmlFor="embed-public-url" label={t('agent_studio.behavior_public_url', 'Public URL')}>
            <CopyField id="embed-public-url" value={publicUrl} onCopy={() => copy(publicUrl)} />
          </SettingBlock>
          <SettingBlock htmlFor="embed-iframe" label={t('agent_studio.behavior_iframe_embed', 'Iframe Embed')}>
            <CopyField id="embed-iframe" value={iframe} onCopy={() => copy(iframe)} />
          </SettingBlock>
        </SettingsList>
      </SettingsGroup>

      <SettingsGroup
        title={t('agent_studio.behavior_chat_bubble_widget', 'Chat Bubble Widget')}
        description={t('agent_studio.behavior_a_floating_chat_button_that_opens_the', 'A floating chat button that opens the agent in a popup. Customize and copy the snippet below.')}
      >
        <SettingsList>
          <div className="px-4 py-3"><BubbleLookFields {...p} /></div>
          <div className="px-4 py-3"><ChatLookFields {...p} /></div>
          <div className="flex items-center gap-3 bg-[var(--bg-secondary)] px-4 py-3">
            {/* The bubble in the owner's own colour: data, so an inline style. */}
            <div
              className="flex shrink-0 items-center justify-center rounded-full"
              style={{ width: previewSize, height: previewSize, fontSize: previewSize * 0.45, background: `linear-gradient(135deg, ${p.bubbleColor}, ${p.bubbleColor}dd)`, boxShadow: `0 4px 16px ${p.bubbleColor}66` }}
            >
              {p.bubbleIcon}
            </div>
            <p className="m-0 text-xs text-[var(--text-tertiary)]">
              {t('agent_studio.behavior_preview_bubble_sizepx_bubble_position', 'Preview · {bubble_size}px · {bubble_position} · {window_width}×{window_height} window', { bubble_size: p.bubbleSize, bubble_position: p.bubblePosition, window_width: p.windowWidth, window_height: p.windowHeight })}
            </p>
          </div>
          <SettingBlock htmlFor="embed-widget-code" label={t('agent_studio.behavior_generated_code', 'Generated Code')}>
            <CopyField id="embed-widget-code" multiline value={widgetSnippet(widget, true)} onCopy={() => copy(widgetSnippet(widget))} />
          </SettingBlock>
        </SettingsList>
      </SettingsGroup>
    </>
  );
}

export const BehaviorSection = (props: DesignerSectionProps) => {
  const { selectedAgent, allowCopy, setAllowCopy, disableExternalTools, setDisableExternalTools, embedEnabled, setEmbedEnabled } = props;
  const { t } = useTranslation();
  const rows = [
    { id: 'copy', checked: allowCopy, onChange: setAllowCopy, label: t('agent_studio.behavior_allow_copying', 'Allow Copying'), hint: t('agent_studio.behavior_allow_copying_hint', 'Users can copy message content to clipboard') },
    { id: 'external', checked: disableExternalTools, onChange: setDisableExternalTools, label: t('agent_studio.behavior_disable_external_tools', 'Disable Integrations & Web Search'), hint: t('agent_studio.behavior_disable_external_tools_hint', 'Block all integration tools and web search for this agent') },
    { id: 'embed', checked: embedEnabled, onChange: setEmbedEnabled, label: t('agent_studio.behavior_web_embed', 'Web Embed'), hint: t('agent_studio.behavior_web_embed_hint', 'Public standalone chat page for embedding') },
  ];
  return (
    <div className="flex max-w-4xl flex-col gap-6 animate-fadeIn">
      <SectionHeader title={t('agent_studio.behavior_behavior_settings', 'Behavior Settings')} />
      <SettingsList>
        {rows.map(r => (
          // A switch needs no wide control column: label and hint take the width.
          <div key={r.id} className="flex items-center justify-between gap-4 px-4 py-3">
            <div className="min-w-0">
              <h4 className="m-0 text-[13px] font-medium text-[var(--text-primary)]">{r.label}</h4>
              <p className="m-0 mt-0.5 text-xs text-[var(--text-tertiary)]">{r.hint}</p>
            </div>
            <Toggle checked={r.checked} onChange={r.onChange} ariaLabel={r.label} />
          </div>
        ))}
      </SettingsList>
      {embedEnabled && selectedAgent && <EmbedSettings {...props} agentId={selectedAgent.id} />}
    </div>
  );
};
