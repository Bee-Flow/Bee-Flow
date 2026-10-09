import React from 'react';
import ModelSelector from '../../../chat/ModelSelector';
import Toggle from '../../../shared/Toggle';
import useCopyToClipboard from '../../../../hooks/useCopyToClipboard';
import { useTranslation } from '../../../../hooks/useTranslation';

export const BehaviorSection = ({
  selectedAgent, name, setName, description, setDescription,
  systemPrompt, setSystemPrompt, avatar, setAvatar,
  showEmojiPicker, setShowEmojiPicker, emojiCategory, setEmojiCategory, emojiPickerRef,
  model, setModel, modelTiers, authFetch, API_BASE,
  activeGuardrailTab, setActiveGuardrailTab, llamaGuardEnabled, setLlamaGuardEnabled,
  webSearchGuardEnabled, setWebSearchGuardEnabled, regexGuardrailsEnabled, setRegexGuardrailsEnabled,
  availableCollections, selectedCollections, setSelectedCollections,
  regexScope, setRegexScope, guardrailAction, setGuardrailAction,
  enabledIntegrations, setEnabledIntegrations, integrationStatus,
  availableModels,
  disableExternalTools, setDisableExternalTools,

  CAPABILITIES, checkCapability, toggleCapability,
  allowCopy, setAllowCopy, embedEnabled, setEmbedEnabled,
  bubbleColor, setBubbleColor, bubblePosition, setBubblePosition,
  bubbleSize, setBubbleSize, bubbleIcon, setBubbleIcon,
  windowWidth, setWindowWidth, windowHeight, setWindowHeight,
  chatFont, setChatFont, chatFontSize, setChatFontSize,
  chatLineHeight, setChatLineHeight, userBubbleColor, setUserBubbleColor,
  assistantBubbleColor, setAssistantBubbleColor, warningText, setWarningText,
  setPromptDesignerMessages, setPromptDesignerInput, setShowPromptDesigner
}) => {
  const { t } = useTranslation();
  const { copy } = useCopyToClipboard();
  return (
                                                <div className="space-y-6 animate-fadeIn">
                                                    <h2 className="text-base font-semibold mb-4 text-primary">{t('agent_studio.behavior_behavior_settings', 'Behavior Settings')}</h2>

                                                    <div className="space-y-4">
                                                        <Toggle
                                                            checked={allowCopy}
                                                            onChange={setAllowCopy}
                                                            label="Allow Copying"
                                                            description="Users can copy message content to clipboard"
                                                        />

                                                        <Toggle
                                                            checked={disableExternalTools}
                                                            onChange={setDisableExternalTools}
                                                            label="Disable Integrations & Web Search"
                                                            description="Block all integration tools and web search for this agent"
                                                            color="amber"
                                                        />

                                                        <Toggle
                                                            checked={embedEnabled}
                                                            onChange={setEmbedEnabled}
                                                            label="Web Embed"
                                                            description="Public standalone chat page for embedding"
                                                        />

                                                        {/* Embed URL Info Card */}
                                                        {embedEnabled && selectedAgent && (
                                                            <div className="p-4 rounded-xl border space-y-3" style={{ borderColor: 'var(--accent-primary)', background: 'rgba(99, 102, 241, 0.05)' }}>
                                                                <div className="flex items-center gap-2 text-sm font-medium" style={{ color: 'var(--accent-primary)' }}>
                                                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" /></svg>
                                                                    {t('agent_studio.behavior_embed_settings', 'Embed Settings')}
                                                                </div>
                                                                <div>
                                                                    <label className="text-xs text-muted mb-1 block">{t('agent_studio.behavior_public_url', 'Public URL')}</label>
                                                                    <div className="flex gap-2">
                                                                        <input
                                                                            readOnly
                                                                            value={`${window.location.origin}/chat/${selectedAgent.id}`}
                                                                            className="flex-1 text-xs font-mono px-3 py-2 rounded-lg border bg-transparent"
                                                                            style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
                                                                        />
                                                                        <button
                                                                            onClick={() => copy(`${window.location.origin}/chat/${selectedAgent.id}`)}
                                                                            className="px-3 py-2 text-xs rounded-lg text-white hover:opacity-90 transition-opacity"
                                                                            style={{ background: 'var(--accent-primary)' }}
                                                                        >
                                                                            {t('agent_studio.behavior_copy', 'Copy')}
                                                                        </button>
                                                                    </div>
                                                                </div>
                                                                <div>
                                                                    <label className="text-xs text-muted mb-1 block">{t('agent_studio.behavior_iframe_embed', 'Iframe Embed')}</label>
                                                                    <div className="flex gap-2">
                                                                        <input
                                                                            readOnly
                                                                            value={`<iframe src="${window.location.origin}/chat/${selectedAgent.id}" width="400" height="600" style="border:none;border-radius:12px;"></iframe>`}
                                                                            className="flex-1 text-xs font-mono px-3 py-2 rounded-lg border bg-transparent"
                                                                            style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
                                                                        />
                                                                        <button
                                                                            onClick={() => copy(`<iframe src="${window.location.origin}/chat/${selectedAgent.id}" width="400" height="600" style="border:none;border-radius:12px;"></iframe>`)}
                                                                            className="px-3 py-2 text-xs rounded-lg text-white hover:opacity-90 transition-opacity"
                                                                            style={{ background: 'var(--accent-primary)' }}
                                                                        >
                                                                            {t('agent_studio.behavior_copy', 'Copy')}
                                                                        </button>
                                                                    </div>
                                                                </div>
                                                                <div className="space-y-3">
                                                                    <label className="text-xs text-muted mb-1 block font-medium">{t('agent_studio.behavior_chat_bubble_widget', 'Chat Bubble Widget')}</label>
                                                                    <p className="text-[10px] text-muted">{t('agent_studio.behavior_a_floating_chat_button_that_opens_the', 'A floating chat button that opens the agent in a popup. Customize and copy the snippet below.')}</p>

                                                                    {/* Styling Options Grid */}
                                                                    <div className="grid grid-cols-2 gap-3">
                                                                        {/* Bubble Color */}
                                                                        <div>
                                                                            <label className="text-[10px] text-muted mb-1 block">{t('agent_studio.behavior_bubble_color', 'Bubble Color')}</label>
                                                                            <div className="flex items-center gap-2">
                                                                                <input
                                                                                    type="color"
                                                                                    value={bubbleColor}
                                                                                    onChange={(e) => setBubbleColor(e.target.value)}
                                                                                    className="w-8 h-8 rounded-lg border-0 cursor-pointer"
                                                                                    style={{ padding: 0 }}
                                                                                />
                                                                                <input
                                                                                    type="text"
                                                                                    value={bubbleColor}
                                                                                    onChange={(e) => setBubbleColor(e.target.value)}
                                                                                    className="flex-1 text-xs font-mono px-2 py-1.5 rounded-lg border bg-transparent"
                                                                                    style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
                                                                                />
                                                                            </div>
                                                                        </div>

                                                                        {/* Position */}
                                                                        <div>
                                                                            <label className="text-[10px] text-muted mb-1 block">{t('agent_studio.behavior_position', 'Position')}</label>
                                                                            <div className="flex gap-1">
                                                                                {['left', 'right'].map(pos => (
                                                                                    <button
                                                                                        key={pos}
                                                                                        onClick={() => setBubblePosition(pos)}
                                                                                        className={`flex-1 px-3 py-1.5 text-xs rounded-lg border transition-colors capitalize ${bubblePosition === pos
                                                                                            ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)]/10 text-[var(--accent-primary)] font-medium'
                                                                                            : 'border-transparent bg-white/5 text-muted hover:text-primary'
                                                                                            }`}
                                                                                    >
                                                                                        {pos === 'left' ? '◀ Left' : 'Right ▶'}
                                                                                    </button>
                                                                                ))}
                                                                            </div>
                                                                        </div>

                                                                        {/* Bubble Size */}
                                                                        <div>
                                                                            <label className="text-[10px] text-muted mb-1 block">{t('agent_studio.behavior_bubble_size_bubble_sizepx', 'Bubble Size: {bubble_size}px', { bubble_size: bubbleSize })}</label>
                                                                            <input
                                                                                type="range"
                                                                                min={40}
                                                                                max={80}
                                                                                value={bubbleSize}
                                                                                onChange={(e) => setBubbleSize(Number(e.target.value))}
                                                                                className="w-full accent-[var(--accent-primary)]"
                                                                            />
                                                                        </div>

                                                                        {/* Icon */}
                                                                        <div>
                                                                            <label className="text-[10px] text-muted mb-1 block">{t('agent_studio.behavior_icon', 'Icon')}</label>
                                                                            <div className="flex gap-1">
                                                                                {['🐝', '💬', '🤖', '❓', '👋'].map(icon => (
                                                                                    <button
                                                                                        key={icon}
                                                                                        onClick={() => setBubbleIcon(icon)}
                                                                                        className={`w-8 h-8 rounded-lg text-base flex items-center justify-center transition-all ${bubbleIcon === icon
                                                                                            ? 'ring-2 ring-[var(--accent-primary)] scale-110'
                                                                                            : 'bg-white/5 hover:bg-white/10'
                                                                                            }`}
                                                                                    >
                                                                                        {icon}
                                                                                    </button>
                                                                                ))}
                                                                            </div>
                                                                        </div>

                                                                        {/* Window Width */}
                                                                        <div>
                                                                            <label className="text-[10px] text-muted mb-1 block">{t('agent_studio.behavior_window_width_window_widthpx', 'Window Width: {window_width}px', { window_width: windowWidth })}</label>
                                                                            <input
                                                                                type="range"
                                                                                min={320}
                                                                                max={500}
                                                                                step={10}
                                                                                value={windowWidth}
                                                                                onChange={(e) => setWindowWidth(Number(e.target.value))}
                                                                                className="w-full accent-[var(--accent-primary)]"
                                                                            />
                                                                        </div>

                                                                        {/* Window Height */}
                                                                        <div>
                                                                            <label className="text-[10px] text-muted mb-1 block">{t('agent_studio.behavior_window_height_window_heightpx', 'Window Height: {window_height}px', { window_height: windowHeight })}</label>
                                                                            <input
                                                                                type="range"
                                                                                min={400}
                                                                                max={800}
                                                                                step={10}
                                                                                value={windowHeight}
                                                                                onChange={(e) => setWindowHeight(Number(e.target.value))}
                                                                                className="w-full accent-[var(--accent-primary)]"
                                                                            />
                                                                        </div>

                                                                        {/* Font Family */}
                                                                        <div>
                                                                            <label className="text-[10px] text-muted mb-1 block">{t('agent_studio.behavior_font_family', 'Font Family')}</label>
                                                                            <select
                                                                                value={chatFont}
                                                                                onChange={(e) => setChatFont(e.target.value)}
                                                                                className="w-full text-xs px-2 py-1.5 rounded-lg border bg-transparent cursor-pointer"
                                                                                style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
                                                                            >
                                                                                <option value="System Default">{t('agent_studio.behavior_system_default', 'System Default')}</option>
                                                                                <option value="Inter">{t('agent_studio.behavior_inter', 'Inter')}</option>
                                                                                <option value="Roboto">{t('agent_studio.behavior_roboto', 'Roboto')}</option>
                                                                                <option value="Open Sans">{t('agent_studio.behavior_open_sans', 'Open Sans')}</option>
                                                                                <option value="Lato">{t('agent_studio.behavior_lato', 'Lato')}</option>
                                                                                <option value="Poppins">{t('agent_studio.behavior_poppins', 'Poppins')}</option>
                                                                                <option value="Nunito">{t('agent_studio.behavior_nunito', 'Nunito')}</option>
                                                                                <option value="Georgia">{t('agent_studio.behavior_georgia', 'Georgia')}</option>
                                                                                <option value="Courier New">{t('agent_studio.behavior_courier_new', 'Courier New')}</option>
                                                                            </select>
                                                                        </div>

                                                                        {/* Font Size */}
                                                                        <div>
                                                                            <label className="text-[10px] text-muted mb-1 block">{t('agent_studio.behavior_font_size_chat_font_sizepx', 'Font Size: {chat_font_size}px', { chat_font_size: chatFontSize })}</label>
                                                                            <input
                                                                                type="range"
                                                                                min={12}
                                                                                max={20}
                                                                                value={chatFontSize}
                                                                                onChange={(e) => setChatFontSize(Number(e.target.value))}
                                                                                className="w-full accent-[var(--accent-primary)]"
                                                                            />
                                                                        </div>

                                                                        {/* Line Height */}
                                                                        <div className="col-span-2">
                                                                            <label className="text-[10px] text-muted mb-1 block">{t('agent_studio.behavior_line_height', 'Line Height: {value}', { value: chatLineHeight })}</label>
                                                                            <input
                                                                                type="range"
                                                                                min={1.2}
                                                                                max={2.0}
                                                                                step={0.1}
                                                                                value={chatLineHeight}
                                                                                onChange={(e) => setChatLineHeight(Number(e.target.value))}
                                                                                className="w-full accent-[var(--accent-primary)]"
                                                                            />
                                                                        </div>
                                                                    </div>

                                                                    {/* Chat Colors */}
                                                                    <div className="grid grid-cols-2 gap-3">
                                                                        <div>
                                                                            <label className="text-[10px] text-muted mb-1 block">{t('agent_studio.behavior_user_bubble_color', 'User Bubble Color')}</label>
                                                                            <div className="flex items-center gap-2">
                                                                                <input
                                                                                    type="color"
                                                                                    value={userBubbleColor || '#6366f1'}
                                                                                    onChange={(e) => setUserBubbleColor(e.target.value)}
                                                                                    className="w-8 h-8 rounded cursor-pointer border-none bg-transparent"
                                                                                />
                                                                                <input
                                                                                    type="text"
                                                                                    value={userBubbleColor}
                                                                                    onChange={(e) => setUserBubbleColor(e.target.value)}
                                                                                    placeholder={t('agent_studio.behavior_default', 'Default')}
                                                                                    className="flex-1 text-xs px-2 py-1.5 rounded-lg border bg-transparent"
                                                                                    style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
                                                                                />
                                                                            </div>
                                                                        </div>
                                                                        <div>
                                                                            <label className="text-[10px] text-muted mb-1 block">{t('agent_studio.behavior_assistant_bubble_color', 'Assistant Bubble Color')}</label>
                                                                            <div className="flex items-center gap-2">
                                                                                <input
                                                                                    type="color"
                                                                                    value={assistantBubbleColor || '#374151'}
                                                                                    onChange={(e) => setAssistantBubbleColor(e.target.value)}
                                                                                    className="w-8 h-8 rounded cursor-pointer border-none bg-transparent"
                                                                                />
                                                                                <input
                                                                                    type="text"
                                                                                    value={assistantBubbleColor}
                                                                                    onChange={(e) => setAssistantBubbleColor(e.target.value)}
                                                                                    placeholder={t('agent_studio.behavior_default', 'Default')}
                                                                                    className="flex-1 text-xs px-2 py-1.5 rounded-lg border bg-transparent"
                                                                                    style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
                                                                                />
                                                                            </div>
                                                                        </div>
                                                                    </div>

                                                                    {/* Warning Text */}
                                                                    <div>
                                                                        <label className="text-[10px] text-muted mb-1 block">{t('agent_studio.behavior_disclaimer_text', 'Disclaimer Text')}</label>
                                                                        <input
                                                                            type="text"
                                                                            value={warningText}
                                                                            onChange={(e) => setWarningText(e.target.value)}
                                                                            placeholder={t('agent_studio.behavior_ai_can_make_mistakes_please_verify', 'AI can make mistakes. Please verify important information.')}
                                                                            className="w-full text-xs px-2 py-1.5 rounded-lg border bg-transparent"
                                                                            style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
                                                                        />
                                                                    </div>

                                                                    {/* Live Preview */}
                                                                    <div className="flex items-center gap-3 p-3 rounded-xl bg-white/5 border" style={{ borderColor: 'var(--border-subtle)' }}>
                                                                        <div
                                                                            style={{
                                                                                width: `${Math.min(bubbleSize, 50)}px`,
                                                                                height: `${Math.min(bubbleSize, 50)}px`,
                                                                                borderRadius: '50%',
                                                                                background: `linear-gradient(135deg, ${bubbleColor}, ${bubbleColor}dd)`,
                                                                                display: 'flex',
                                                                                alignItems: 'center',
                                                                                justifyContent: 'center',
                                                                                fontSize: `${Math.min(bubbleSize, 50) * 0.45}px`,
                                                                                boxShadow: `0 4px 16px ${bubbleColor}66`,
                                                                                flexShrink: 0
                                                                            }}
                                                                        >
                                                                            {bubbleIcon}
                                                                        </div>
                                                                        <div className="text-[10px] text-muted">
                                                                            {t('agent_studio.behavior_preview_bubble_sizepx_bubble_position', 'Preview · {bubble_size}px · {bubble_position} · {window_width}×{window_height} window', { bubble_size: bubbleSize, bubble_position: bubblePosition, window_width: windowWidth, window_height: windowHeight })}
                                                                        </div>
                                                                    </div>

                                                                    {/* Generated Code */}
                                                                    <div>
                                                                        <label className="text-[10px] text-muted mb-1 block">{t('agent_studio.behavior_generated_code', 'Generated Code')}</label>
                                                                        <div className="flex gap-2">
                                                                            <textarea
                                                                                readOnly
                                                                                rows={3}
                                                                                value={(() => {
                                                                                    const pos = bubblePosition === 'left' ? 'left:24px' : 'right:24px';
                                                                                    const fontParams = [];
                                                                                    if (chatFont !== 'System Default') fontParams.push(`font=${encodeURIComponent(chatFont)}`);
                                                                                    if (chatFontSize !== 14) fontParams.push(`fontSize=${chatFontSize}`);
                                                                                    if (chatLineHeight !== 1.5) fontParams.push(`lineHeight=${chatLineHeight}`);
                                                                                    if (userBubbleColor) fontParams.push(`userColor=${encodeURIComponent(userBubbleColor)}`);
                                                                                    if (assistantBubbleColor) fontParams.push(`assistantColor=${encodeURIComponent(assistantBubbleColor)}`);
                                                                                    if (warningText) fontParams.push(`warning=${encodeURIComponent(warningText)}`);
                                                                                    const paramStr = fontParams.length ? (selectedAgent.id.includes('?') ? '&' : '?') + fontParams.join('&') : '';
                                                                                    const chatUrl = `${window.location.origin}/chat/${selectedAgent.id}${paramStr}`;
                                                                                    return `<!-- Bee Flow Chat Widget -->\n<script>\n(function(){\n  var d=document,s=d.createElement('style'),b=d.createElement('div');\n  s.textContent='#bf-bubble{position:fixed;bottom:24px;${pos};width:${bubbleSize}px;height:${bubbleSize}px;border-radius:50%;background:linear-gradient(135deg,${bubbleColor},${bubbleColor}dd);border:none;cursor:pointer;box-shadow:0 4px 20px ${bubbleColor}66;display:flex;align-items:center;justify-content:center;font-size:${Math.round(bubbleSize * 0.45)}px;transition:transform .3s,box-shadow .3s;z-index:10001}#bf-bubble:hover{transform:scale(1.1)}#bf-bubble.open{background:linear-gradient(135deg,#e74c3c,#c0392b);box-shadow:0 4px 20px rgba(231,76,60,.4)}#bf-window{position:fixed;bottom:${bubbleSize + 40}px;${pos};width:${windowWidth}px;height:${windowHeight}px;border-radius:16px;overflow:hidden;box-shadow:0 12px 48px rgba(0,0,0,.15);opacity:0;transform:translateY(20px) scale(.95);pointer-events:none;transition:opacity .3s,transform .3s;z-index:10000}#bf-window.open{opacity:1;transform:translateY(0) scale(1);pointer-events:auto}#bf-window iframe{width:100%;height:100%;border:none}';\n  d.head.appendChild(s);\n  b.innerHTML='<div id="bf-window"><iframe src="${chatUrl}"><\\/iframe><\\/div><button id="bf-bubble">${bubbleIcon}<\\/button>';\n  d.body.appendChild(b);\n  d.getElementById('bf-bubble').onclick=function(){var w=d.getElementById('bf-window'),t=this;t.classList.toggle('open');w.classList.toggle('open');t.textContent=t.classList.contains('open')?'\\u2715':'${bubbleIcon}'};\n})();\n<\\/script>`;
                                                                                })()}
                                                                                className="flex-1 text-xs font-mono px-3 py-2 rounded-lg border bg-transparent resize-none"
                                                                                style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
                                                                            />
                                                                            <button
                                                                                onClick={() => {
                                                                                    const pos = bubblePosition === 'left' ? 'left:24px' : 'right:24px';
                                                                                    const fontParams = [];
                                                                                    if (chatFont !== 'System Default') fontParams.push(`font=${encodeURIComponent(chatFont)}`);
                                                                                    if (chatFontSize !== 14) fontParams.push(`fontSize=${chatFontSize}`);
                                                                                    if (chatLineHeight !== 1.5) fontParams.push(`lineHeight=${chatLineHeight}`);
                                                                                    if (userBubbleColor) fontParams.push(`userColor=${encodeURIComponent(userBubbleColor)}`);
                                                                                    if (assistantBubbleColor) fontParams.push(`assistantColor=${encodeURIComponent(assistantBubbleColor)}`);
                                                                                    if (warningText) fontParams.push(`warning=${encodeURIComponent(warningText)}`);
                                                                                    const paramStr = fontParams.length ? (selectedAgent.id.includes('?') ? '&' : '?') + fontParams.join('&') : '';
                                                                                    const chatUrl = `${window.location.origin}/chat/${selectedAgent.id}${paramStr}`;
                                                                                    const code = `<!-- Bee Flow Chat Widget -->\n<script>\n(function(){\n  var d=document,s=d.createElement('style'),b=d.createElement('div');\n  s.textContent='#bf-bubble{position:fixed;bottom:24px;${pos};width:${bubbleSize}px;height:${bubbleSize}px;border-radius:50%;background:linear-gradient(135deg,${bubbleColor},${bubbleColor}dd);border:none;cursor:pointer;box-shadow:0 4px 20px ${bubbleColor}66;display:flex;align-items:center;justify-content:center;font-size:${Math.round(bubbleSize * 0.45)}px;transition:transform .3s,box-shadow .3s;z-index:10001}#bf-bubble:hover{transform:scale(1.1)}#bf-bubble.open{background:linear-gradient(135deg,#e74c3c,#c0392b);box-shadow:0 4px 20px rgba(231,76,60,.4)}#bf-window{position:fixed;bottom:${bubbleSize + 40}px;${pos};width:${windowWidth}px;height:${windowHeight}px;border-radius:16px;overflow:hidden;box-shadow:0 12px 48px rgba(0,0,0,.15);opacity:0;transform:translateY(20px) scale(.95);pointer-events:none;transition:opacity .3s,transform .3s;z-index:10000}#bf-window.open{opacity:1;transform:translateY(0) scale(1);pointer-events:auto}#bf-window iframe{width:100%;height:100%;border:none}';\n  d.head.appendChild(s);\n  b.innerHTML='<div id="bf-window"><iframe src="${chatUrl}"><\\/iframe><\\/div><button id="bf-bubble">${bubbleIcon}<\\/button>';\n  d.body.appendChild(b);\n  d.getElementById('bf-bubble').onclick=function(){var w=d.getElementById('bf-window'),t=this;t.classList.toggle('open');w.classList.toggle('open');t.textContent=t.classList.contains('open')?'\\u2715':'${bubbleIcon}'};\n})();\n</script>`;
                                                                                    copy(code);
                                                                                }}
                                                                                className="px-3 py-2 text-xs rounded-lg text-white hover:opacity-90 transition-opacity self-start"
                                                                                style={{ background: 'var(--accent-primary)' }}
                                                                            >
                                                                                {t('agent_studio.behavior_copy', 'Copy')}
                                                                            </button>
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                                <p className="text-[10px] text-muted">{t('agent_studio.behavior_agent_must_be_published_for_the_embed', 'Agent must be Published for the embed link to work.')}</p>
                                                            </div>
                                                        )}

                                                    </div>
                                                </div>
  );
};
