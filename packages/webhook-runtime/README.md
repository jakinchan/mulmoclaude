# @mulmobridge/webhook-runtime

Shared HTTP-webhook plumbing for the MulmoClaude messaging bridges that
receive events over an inbound webhook (LINE, WhatsApp, Viber, LINE WORKS,
Messenger, Google Chat).

- `createWebhookApp({ bodyLimit? })` — Express app with `x-powered-by`
  disabled, `BRIDGE_TRUST_PROXY` honoured, and raw-text body parsing so the
  HMAC signature can be verified before JSON parsing.
- `configureTrustProxy(app, env?)` — parse `BRIDGE_TRUST_PROXY`
  (boolean / hop-count / preset / CIDR) and apply it.
- `createWebhookRateLimit(limitPerMinute?)` — IPv6-safe per-IP rate limit.
- `verifyHmacSignature(body, signature, secret, algorithm?, encoding?)` —
  length-guarded, timing-safe HMAC comparison.

For the Meta platforms (Messenger, WhatsApp), which share one webhook contract:

- `registerMetaWebhook(app, { verifyToken, appSecret, label, ackBody?, onBody })` —
  the whole `/webhook` surface in one call:
  - **GET** — the handshake that echoes `hub.challenge` only after the token matches.
  - **POST** — `x-hub-signature-256` check → `401` on failure, otherwise ack `200`
    **before** awaiting `onBody(rawBody)` so a slow handler can't trigger a Meta
    redelivery.

  Both routes share one rate-limit bucket, built inside the registrar (a flood of
  bogus `hub.challenge` GETs hammers the bridge just as effectively as POSTs).
- `registerMetaWebhookVerification(app, { rateLimit, verifyToken, label })` — the
  GET half on its own, for a caller that owns the limiter.
- `verifyMetaHmacSignature(body, signature, appSecret)` — the hex/SHA-256 HMAC
  check with Meta's `sha256=` prefix stripped.

These are security-relevant and hardened through Codex reviews (#1326);
keeping one copy means a fix lands once, not once per bridge.

## Related projects

Published from the MulmoClaude monorepo by [Receptron](https://github.com/receptron).

- **[MulmoClaude](https://github.com/receptron/mulmoclaude)** — an open-source AI assistant platform that runs on your own computer. Claude Code as the engine, a personal wiki for long-term memory, schema-driven collections for your data, and chat that summons the right GUI (markdown, charts, forms, spreadsheets, wikis) for each task.
- **[MulmoTerminal](https://github.com/receptron/mulmoterminal)** — a terminal-first cockpit for running many AI coding agents in parallel. One roster showing every session's summary and PR status, tmux-backed session persistence, git-worktree isolation, one-click PRs, and mobile push with remote reply.
- **[MulmoTerminal manual](https://receptron.github.io/mulmoterminal/)** — setup, workflows, feature reference, configuration, mobile notifications, and alternative / local model providers. Available in English and Japanese.
