# Stripe billing setup (compliance & portal)

Operational checklist for a legally complete Dutch B2B invoice (Wet OB 1968)
and a consistent checkout/portal experience. Code-side support shipped with
the BFSF-243/250/241 fixes; the steps below are **Stripe Dashboard
configuration** that cannot live in this repository.

## 1. Invoice branding & company details (BFSF-250)

In the [Stripe Dashboard](https://dashboard.stripe.com):

1. **Settings → Business → Branding** — upload the Bee Flow logo and icon.
   These appear on the invoice PDF and the hosted invoice page.
2. **Settings → Billing → Invoice template** — set the default footer with:
   - KvK-nummer
   - BTW-nummer (VAT id)
   - Full registered address
   - IBAN / bank details
3. Under **Manage tax IDs**, add the company's NL BTW id so it prints in the
   invoice header.

## 2. Stripe Tax — 21% BTW breakdown (BFSF-250)

Without Stripe Tax, invoices carry **no VAT lines** — customers cannot reclaim
BTW, a hard blocker for Dutch B2B.

1. **Activate Stripe Tax** in the Dashboard: set the origin address (NL) and
   add the NL VAT registration (21%). This also enables automatic EU B2B
   reverse charge.
2. In Bee Flow: **Admin → Subscriptions → Stripe → Enable Stripe Tax**.
   Flipping the toggle automatically backfills `automatic_tax` onto existing
   active/trialing subscriptions (customers without a billing address are
   skipped and logged — complete their addresses, then re-toggle to retry).
3. **Re-sync every plan** after enabling: prices minted while the toggle was
   off lack `tax_behavior` and checkout fails against them. Sync creates
   fresh prices with `tax_behavior: exclusive`.

> ⚠️ **Real billing impact**: with `tax_behavior: exclusive`, the customer's
> next invoice increases by 21% BTW. Announce this to existing customers
> before enabling. Verify in **test mode** first, with a **paid** invoice —
> a 100%-discounted (e.g. `TESTER30DAYSFREE`) invoice shows €0.00 BTW even
> when everything is configured correctly.

## 3. Customer Portal payment methods (BFSF-241)

The portal previously offered Card/Pix/Kakao Pay/Amazon Pay while checkout
offers iDEAL|Wero/Card/Klarna.

- **Settings → Billing → Customer portal → Payment methods**: align with the
  checkout set — keep **Card + iDEAL/SEPA** (dunning customers must be able to
  fix their payment method), disable Pix, Kakao Pay, Amazon Pay.
- The app now also gates the portal server-side: only customers with a
  paid/dunning payment status can open it (trial/free users see the plan
  picker instead).

## 4. Checkout ToS consent (optional, BFSF-243)

`consent_collection.terms_of_service` on the hosted checkout is config-gated
behind the `stripe_tos_consent_enabled` config key because Stripe hard-fails
session creation when no ToS URL is configured. To enable:

1. Set the Terms of Service URL at **Settings → Public details**
   (dashboard.stripe.com/settings/public).
2. Set the config key `stripe_tos_consent_enabled` to a truthy value.

## 5. Deploy-time script

Run the consolidated Dutch-translation seed once per environment (idempotent):

```bash
node server/migrations/add-nl-bfsf-sweep-translations.js
```

## 6. Google Workspace connector redirect URI (BFSF-255)

Not billing, but part of the same release: register the connector callback on
the Google OAuth client in Google Cloud Console → Credentials, next to the
existing SSO redirect:

```
https://<host>/api/integrations/google/callback
```

Add it for production (beeflow.nl), staging, local dev, and document it for
self-hosters. Until it is registered, the Connections-page "Connect Google
Workspace" popup fails with `redirect_uri_mismatch`.
