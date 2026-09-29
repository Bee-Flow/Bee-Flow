---
title: Components
---

# Components

Components are AI-generated UI building blocks you can drop into chat replies, automation outputs, or webpages. They're built by the **Component Designer** — an agent that converts a description into a working React component.

URL: `/app/components`.

![Component designer](../img/screenshots/studio/component-designer/)

## What a component looks like

A component is a self-contained, sandboxed React fragment with:

- A schema (typed inputs the parent passes in)
- A render function (the JSX/HTML)
- Optional `state` (declared upfront, not free-form `useState`)
- Optional inline data (small JSON blobs the agent embeds)

Examples:

- A coloured pill showing a status with a tooltip
- A donut chart of automation runs by status
- A 3-column card grid summarising a research run
- An input form for an automation approval step

## Why this matters

LLMs reply in Markdown. Markdown can't easily render charts, custom layouts, structured forms. Components close that gap — the agent thinks "I want to render this as a donut chart" and emits a component invocation; Bee Flow renders it sandboxed.

## Designing a component

In the Component Designer:

1. Describe what you want ("a status pill, green if 'success', red if 'failed', amber otherwise").
2. The Designer (a system agent) generates code + schema.
3. Preview in the right pane with mock data.
4. Iterate via chat ("make it bigger", "use the org's accent colour").
5. Save to your component library.

## Using a component

Inside an agent's system prompt:

```
When you need to display a status, use the `StatusPill` component:
{
  "component": "StatusPill",
  "props": { "status": "success", "label": "All systems normal" }
}
```

The agent emits the JSON in its reply; the chat surface intercepts it and renders the component instead of showing the raw JSON.

## Sandboxing

Components run in a sandboxed renderer:

- No `eval`, no `dangerouslySetInnerHTML`
- No network calls (data must be passed in via props)
- No user-data access beyond what the agent puts in props
- No global window mutation

This means a malicious or buggy component can't escape the chat surface. Trade-off: components are pure-presentational — for interactivity (form submits) you build the form in a component and the submit handler talks back through Bee Flow's standard SSE channel.

## Sharing components

| Visibility | Where it shows |
|------------|----------------|
| Just me | Your component library only. |
| Team | Selected groups can use it in their agents. |
| Org | Available to every agent in the org. |
| Public | Marketplace (admin review if required). |

## When NOT to use a component

- For plain text replies — use Markdown.
- For images — agents can render images via `image_gen` directly.
- For PDFs — let the agent point at a file via the file integration.
- For large interactive UIs — better candidates for [Webpages](../api/rest.md) (Pro+).
