// The snippet a site owner pastes to get the floating chat bubble of an
// agent. Split out of BehaviorSection, where it was written out twice: the
// read-only preview ends in an escaped "<\/script>", the copied code in a real
// closing tag. Both endings are kept exactly as they were.

export interface WidgetOptions {
  agentId: string;
  origin: string;
  bubbleColor: string;
  bubblePosition: string;
  bubbleSize: number;
  bubbleIcon: string;
  windowWidth: number;
  windowHeight: number;
  chatFont: string;
  chatFontSize: number;
  chatLineHeight: number;
  userBubbleColor: string;
  assistantBubbleColor: string;
  warningText: string;
}

/** The chat page URL with the look parameters that differ from the defaults. */
export function widgetChatUrl(o: WidgetOptions): string {
  const fontParams: string[] = [];
  if (o.chatFont !== 'System Default') fontParams.push(`font=${encodeURIComponent(o.chatFont)}`);
  if (o.chatFontSize !== 14) fontParams.push(`fontSize=${o.chatFontSize}`);
  if (o.chatLineHeight !== 1.5) fontParams.push(`lineHeight=${o.chatLineHeight}`);
  if (o.userBubbleColor) fontParams.push(`userColor=${encodeURIComponent(o.userBubbleColor)}`);
  if (o.assistantBubbleColor) fontParams.push(`assistantColor=${encodeURIComponent(o.assistantBubbleColor)}`);
  if (o.warningText) fontParams.push(`warning=${encodeURIComponent(o.warningText)}`);
  const paramStr = fontParams.length ? (o.agentId.includes('?') ? '&' : '?') + fontParams.join('&') : '';
  return `${o.origin}/chat/${o.agentId}${paramStr}`;
}

/**
 * The widget code. `escapedClose` gives the preview's "<\/script>" ending;
 * without it the snippet ends in a real closing tag, as the copied code does.
 */
export function widgetSnippet(o: WidgetOptions, escapedClose = false): string {
  const { bubbleColor, bubbleSize, bubbleIcon, windowWidth, windowHeight } = o;
  const pos = o.bubblePosition === 'left' ? 'left:24px' : 'right:24px';
  const chatUrl = widgetChatUrl(o);
  const close = escapedClose ? '<\\/script>' : '</script>';
  return `<!-- Bee Flow Chat Widget -->\n<script>\n(function(){\n  var d=document,s=d.createElement('style'),b=d.createElement('div');\n  s.textContent='#bf-bubble{position:fixed;bottom:24px;${pos};width:${bubbleSize}px;height:${bubbleSize}px;border-radius:50%;background:linear-gradient(135deg,${bubbleColor},${bubbleColor}dd);border:none;cursor:pointer;box-shadow:0 4px 20px ${bubbleColor}66;display:flex;align-items:center;justify-content:center;font-size:${Math.round(bubbleSize * 0.45)}px;transition:transform .3s,box-shadow .3s;z-index:10001}#bf-bubble:hover{transform:scale(1.1)}#bf-bubble.open{background:linear-gradient(135deg,#e74c3c,#c0392b);box-shadow:0 4px 20px rgba(231,76,60,.4)}#bf-window{position:fixed;bottom:${bubbleSize + 40}px;${pos};width:${windowWidth}px;height:${windowHeight}px;border-radius:16px;overflow:hidden;box-shadow:0 12px 48px rgba(0,0,0,.15);opacity:0;transform:translateY(20px) scale(.95);pointer-events:none;transition:opacity .3s,transform .3s;z-index:10000}#bf-window.open{opacity:1;transform:translateY(0) scale(1);pointer-events:auto}#bf-window iframe{width:100%;height:100%;border:none}';\n  d.head.appendChild(s);\n  b.innerHTML='<div id="bf-window"><iframe src="${chatUrl}"><\\/iframe><\\/div><button id="bf-bubble">${bubbleIcon}<\\/button>';\n  d.body.appendChild(b);\n  d.getElementById('bf-bubble').onclick=function(){var w=d.getElementById('bf-window'),t=this;t.classList.toggle('open');w.classList.toggle('open');t.textContent=t.classList.contains('open')?'\\u2715':'${bubbleIcon}'};\n})();\n${close}`;
}
