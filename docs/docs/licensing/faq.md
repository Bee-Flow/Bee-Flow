---
title: Fair-code FAQ
---

# Fair-code FAQ

## What is "fair-code"?

Fair-code is source code that:

- Is freely available
- Can be modified and self-hosted
- Has restrictions on commercial use by third parties

It's not OSI-approved "open source", but it preserves most of the freedoms developers care about — auditing, contributing, self-hosting.

## What can I do?

✅ Self-host Bee Flow for your own company / non-profit / personal use, free of charge.

✅ Modify the source. Fork the repos. Submit PRs.

✅ Use it commercially **inside** your organisation — to serve your own employees / customers via your own product.

✅ Audit every line of code that runs against your data.

✅ Sub-licence Bee Flow to your customers if you have a **Full tier** licence (`license_issuance` feature).

✅ Embed Bee Flow chat in another product you ship internally.

## What can't I do?

❌ Run Bee Flow as a paid SaaS for third parties (e.g. spinning up "Acme Bee Flow" and reselling it). Not without a commercial agreement.

❌ Use the **"Bee Flow"** name or **bee logo** on a fork — those are trademarks of Bee Flow B.V.

❌ Strip the licence headers / attribution from source files.

❌ Fork the licence text itself and call it something else.

## Why not pure AGPL or MIT?

- **MIT** would let competitors take the code and resell Bee Flow as their own SaaS — that funds nothing back into the project.
- **AGPL** requires anyone hosting a modified version to publish their changes, which scares off enterprise self-hosters who can't legally publish their internal patches.

The Sustainable Use Licence threads the needle: maximally permissive for end-users and self-hosters, narrowly restricted on third-party SaaS resale.

## Why is the connector AGPL-3.0?

The Nextcloud App Store requires AGPL or compatible licences. The connector is a thin proxy + lifecycle bridge — small enough that AGPL's "publish your modifications" obligation is fine for a Bee Flow fork to comply with.

## Is the SUL OSI-approved?

No. SUL is fair-code, not OSS. We picked fair-code consciously — see "Why not pure AGPL or MIT?" above. Plausible and several other projects use the same model.

## Can I use Bee Flow inside a commercial product I sell?

✅ **Yes**, if Bee Flow runs *inside* your customer's environment (you ship them an installable that they self-host, and you charge for support / customisation). The end-user is your customer; you're not running a Bee Flow SaaS.

❌ **No**, if you stand up a single instance of Bee Flow and charge multiple unrelated customers per-seat to use it. That's resale; you need a commercial agreement.

If unsure, email [tomkooy@beeflow.nl](mailto:tomkooy@beeflow.nl) with a description and we'll respond within a couple of business days.

## Can I contribute?

Yes — bug reports, feature requests and PRs are welcome on GitHub. By submitting a contribution, you agree to license it under the same terms as the project (SUL for `hive` / `beeflow`, AGPL for `connector`).

## What about the `docs` repo?

This documentation site is **CC-BY-4.0** (prose) + **MIT** (code samples). Reuse freely with attribution.

## Where can I see the licence text?

- Frontend: [github.com/Bee-Flow/hive/blob/main/LICENSE.md](https://github.com/Bee-Flow/hive/blob/main/LICENSE.md)
- Server: [github.com/Bee-Flow/beeflow/blob/main/LICENSE.md](https://github.com/Bee-Flow/beeflow/blob/main/LICENSE.md)
- Connector: [github.com/Bee-Flow/connector/blob/main/LICENSE.md](https://github.com/Bee-Flow/connector/blob/main/LICENSE.md)

## Can I deploy a fork under a different name?

Yes — you must rename it (drop "Bee Flow" and the bee mark) and remove our trademarks from the UI. Otherwise yes, free to ship.

## Where do I email about licensing?

[tomkooy@beeflow.nl](mailto:tomkooy@beeflow.nl) — we'll respond within 2 business days. For commercial / resale enquiries please mention your use case and expected scale.

## What happens if Bee Flow B.V. goes away?

The code is already public on GitHub. Existing self-hosted deployments keep running. Existing licence keys keep working through their `exp` (refresh check is non-fatal — see [Apply](apply.md)). The trademark would need a new owner; the source can be forked under a different name.
