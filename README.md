# cf-email-gateway

A Cloudflare Worker that connects Cloudflare Email Routing to the guardians of
AI agents. Deploy one instance per mail domain.

Each agent address gets its own SQLite-backed Durable Object, `Mailbox`
(`idFromName(address)`). The agent's guardian (`cf-email-unwrapper`) keeps a
WebSocket open to its Mailbox, receives inbound mail over it and sends replies
back through it. Agents themselves only speak A2A; the guardian does all
S/MIME and A2A work.

```mermaid
flowchart LR
  sender[Sender] -->|SMTP| routing[Email Routing]
  routing -->|email handler| worker[Worker]
  worker -->|deliver| mailbox["Mailbox DO (per address)"]
  guardian[Guardian] <-->|"WebSocket /mailbox/&lt;address&gt;"| mailbox
  mailbox -->|send_email| recipient[Verified recipient]
```

## What it does

- **Inbound** (`email` handler): reads the raw message Email Routing delivers
  and hands it to the Mailbox of the lowercased recipient address, which
  stores it and pushes it to the connected guardian, if any. If the Mailbox
  cannot take the message, the SMTP transaction is rejected with "Mailbox
  temporarily unavailable".
- **Guardian connection** (`fetch` handler, `GET /mailbox/<address>`): checks
  the token and forwards the WebSocket upgrade to the Mailbox. On every new
  connection the Mailbox sends all stored mail, oldest first.
- **Outbound**: the guardian sends a finished reply over the WebSocket; the
  Mailbox sends it unchanged through the `send_email` binding, with the
  mailbox address as envelope sender.

## What it does not do

- No S/MIME: it never decrypts, signs, encrypts or verifies anything and holds
  no keys.
- No sender or signature checks. Email Routing only routes whitelisted agent
  addresses to this Worker; everything else is checked by the guardian.
- No agent logic and no message parsing.

## Contract

### Connection

```
GET /mailbox/<address>
Upgrade: websocket
Authorization: Bearer <token>
```

`<address>` may be percent-encoded; the Worker trims and lowercases it. The
token is the lowercase hex HMAC-SHA256 of the lowercased address, keyed with
the UTF-8 bytes of the Worker secret `GATEWAY_SECRET`; it is compared in
constant time.

| Condition | Response |
| --- | --- |
| Path other than `/mailbox/<address>` | 404 |
| `GATEWAY_SECRET` not configured | 500 |
| Missing or wrong token | 401 |
| No `Upgrade: websocket` | 426 |
| Otherwise | 101, WebSocket to the address's Mailbox |

A Mailbox keeps one connection: accepting a new socket closes older ones with
code 4000, reason `replaced`. The guardian keeps the connection alive with
WebSocket protocol pings, which Cloudflare answers without waking the Durable
Object.

### Frames

A binary frame is a UTF-8 JSON header, `\n`, then raw bytes.

| Direction | Frame | Content |
| --- | --- | --- |
| Mailbox → guardian | binary | `{"type":"mail","id":"<uuid>","from":"<envelope from>","to":"<address>","receivedAt":"<ISO 8601>","size":<raw byte length>}` + raw `.eml` |
| guardian → Mailbox | text | `{"type":"ack","id":"<mail id>"}`: deletes the mail; unknown ids are ignored; no reply |
| guardian → Mailbox | binary | `{"type":"send","id":"<client-chosen id>","to":"<recipient>"}` + raw reply `.eml` |
| Mailbox → guardian | text | `{"type":"sent","id":"…"}` or `{"type":"error","id":"…","message":"…"}` in answer to `send` |
| Mailbox → guardian | text | `{"type":"error","id":null,"message":"…"}` for an unparseable frame |

A reply is sent with `new EmailMessage(<address>, <to>, raw)`: envelope
sender is the mailbox address, envelope recipient the header's `to`. The
message's `From:` header must match the mailbox address and `to` must be a
verified destination address.

### Guarantees

- Delivery is at least once. Mail stays in the Mailbox until it is acked;
  unacked mail is resent on the next connection only (not while the same
  connection stays open). The guardian deduplicates by `Message-ID`.
- Mail is kept for at most 14 days: every delivery first deletes stored mail
  older than that.

### Logs

One JSON line per event: `received` (id, from, to, size) and `rejected`
(inbound); `sent` and `send_failed` (outbound); `push_failed` if a frame could
not be written to the connected socket (the mail stays stored).

## Operator setup

1. **Deploy** once: `npm install && npx wrangler deploy`, or import this
   repository in **Workers & Pages → Create application → Import a
   repository** (Workers Builds; build command `npm run check && npm test`,
   deploy command `npx wrangler deploy`). The deployment creates the
   `Mailbox` Durable Object class; nothing else has to exist beforehand.
2. **Secret** `GATEWAY_SECRET` (Worker → Settings → Variables and Secrets,
   type Secret, or `npx wrangler secret put GATEWAY_SECRET`), generated with:

   ```sh
   openssl rand -hex 32
   ```

   It is a secret rather than a `[vars]` entry, so deployments do not reset
   it. Rotating it invalidates every guardian token.
3. **Email Routing**: on the mail domain, add one custom address rule per
   agent address with the action "Send to a Worker" → `cf-email-gateway`. Do
   not use a catch-all rule.
4. **Recipients**: add every address that agents may reply to as a verified
   destination address in Email Routing; `send_email` only delivers to
   verified addresses.
5. **Guardian token** for an agent address:

   ```sh
   printf %s hermes@example.org | openssl dgst -sha256 -hmac "$GATEWAY_SECRET" -r | cut -d' ' -f1
   ```

   The address must be lowercase.
6. **Observability**: Workers Logs are enabled in `wrangler.toml`.

The previous transport's queues (`mail-*`, `email-outbox`,
`email-outbox-dlq`) and R2 bucket `email-agents` are no longer used and can be
deleted by hand, as can the old secrets `CF_ACCOUNT_ID` and `CF_API_TOKEN`.

## Limits and costs

- Email Routing caps inbound mail at 25 MiB. The Mailbox stores raw mail in
  1 MiB SQLite chunks, because a SQLite row is limited to 2 MB.
- A reply must fit into one WebSocket message, which Durable Objects accept up
  to 32 MiB.
- A connected guardian uses the WebSocket Hibernation API: an idle, hibernated
  Durable Object is not billed for duration, and protocol pings do not wake it.
  Costs come from requests (inbound mail, WebSocket messages) and SQLite
  storage of mail not yet acked.

## Development

```sh
nix develop      # optional: Node.js toolchain
npm install
npm run check    # tsc --noEmit
npm test         # vitest in the Workers runtime (@cloudflare/vitest-plugin)
```

The tests run the Worker and its Durable Object in a local workerd. Miniflare's
`send_email` binding stands in for Email Routing: it checks that the `From:`
header matches the envelope sender and only allows `author@example.com` as
recipient (see `vitest.config.ts`).
