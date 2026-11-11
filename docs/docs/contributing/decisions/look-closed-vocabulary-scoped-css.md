---
title: "0022: The look of an app is a closed vocabulary plus a scoped stylesheet; there is no free markup in the SPA"
description: Why App Studio lets authors change the look through a closed list of settings and one scoped, stripped stylesheet, and never through their own HTML or scripts on the page.
---

# 0022: The look of an app is a closed vocabulary plus a scoped stylesheet; there is no free markup in the SPA

**Status:** accepted, in effect. **Supersedes:** no earlier record. It replaces the earlier stance that
an app could only change its look through the theme and a short list of style settings.
**Code:** `server/appStudio/appCss.mts` (what a stylesheet may hold; the page half is
`agent-hub/src/components/admin/Studio/AppStudio/runtime/appCss.ts`), `server/core/forms/formCss.mts`
(the sanitiser it builds on), `server/appStudio/appAssets.mts` (uploaded files: raster images and
WOFF2 only, no SVG), `server/appStudio/designTokens.mts`, `server/appStudio/appFontRoles.js`,
`server/appStudio/componentSpecs/styleKnobGroups/`. **Enforced by:**
`server/appStudio/appCss.test.js` and the vectors in `appCss.vectors.json`, which the page half runs
too (`runtime/appCss.test.ts`), so the two stay in step; `runtime/AppCustomCss.test.tsx`;
`server/appStudio/appAssets.test.js`; `runtime/markdownRich.test.tsx` (raw HTML never renders);
`server/appStudio/validate` look checks (contrast warnings); and the look snapshots under
`__lookSnapshots__`, which prove that an app that uses none of it looks the same.

## Context

Authors want more control over how an app looks than a theme and a handful of settings give. The
usual answer, "let them write HTML and CSS", puts author markup inside the signed-in product, where
a path on this server is a request made as the viewer, and where a stylesheet can hide or
re-label the product's own controls.

## Decision

- **The vocabulary is closed and grows by catalogue.** Colours, spans per screen size, the box and
  text settings, conditional style, tokens, a dark palette, font roles, the shell and the rest are
  declared settings with ranges. Nothing here takes markup.
- **A conditional style rule sets look settings only.** Layout settings are never conditional.
- **One stylesheet, scoped.** An app may carry one stylesheet. The page wraps it in an `@scope` of
  the app's own root, so every rule matches inside the app and never the navigation or the product.
  A browser without `@scope` applies none of it.
- **The sanitiser removes, and says what.** Saving strips every at-rule but `@media`, `@supports`
  and `@container`, `position: fixed`, and any `url()` that is not `data:image/…` or an uploaded
  file of the app (`asset:<id>`). The removal is named in the repair hints.
- **No free markup.** Text templates and cell templates give plain text. Markdown never renders raw
  HTML, and its images are uploaded files of the app. There is no component that holds markup or a
  script.
- **Files are the app's own.** Pictures and fonts are uploaded to the app, scanned, size-limited and
  referenced as `asset:<id>`. A font is served by Bee Flow itself, so no page loads a font from
  another host.
- **The stylesheet is a convenience, not a requirement.** Under the high-contrast theme it is not
  applied, and the phone ignores class names.

## Consequences

- An author can do a lot with the look, and still not change what a control says or does, or load
  anything from outside.
- Two implementations (server and page) of the stylesheet rules exist, kept in step by shared test
  vectors. A change to the rules changes both and the vectors.
- The class names and attributes a stylesheet may rely on are a contract: `[data-app-screen]`,
  `[data-section-id]`, `[data-node-id]`, `[data-app-type]`, `.u-<name>` and the part classes
  a type lists. Any other class of the product can change without notice.
