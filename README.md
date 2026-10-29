# cf-email-gateway

A Cloudflare Worker that connects Cloudflare Email Routing to per-agent
Cloudflare Queues. Deploy one instance per mail domain.

## What it does

- **Inbound** (`email` handler): for every message Email Routing delivers to
  the Worker, it stores the raw `.eml` bytes in the R2 bucket `email-agents`,
  makes sure the agent's inbound queue exists (creating the queue and an
  HTTP pull consumer on first use), and pushes a small reference message into
  that queue. If anything fails after the object was written, the object is
  deleted and the SMTP transaction is rejected.
- **Outbound** (`queue` handler on `email-outbox`): decodes each finished
  reply and sends it unchanged through the `send_email` binding. Malformed
  queue messages are logged and dropped; send failures are retried and end up
  in `email-outbox-dlq` after the retry limit.

## What it does not do

- No S/MIME: it never decrypts, signs, encrypts or verifies anything and holds
  no keys.
- No sender or signature checks. Email Routing only routes whitelisted agent
  addresses to this Worker; everything else is verified by the consumer of the
  inbound queue (the unwrapper).
- No agent logic and no message parsing.

## Contract

### Queue naming

The inbound queue for an agent address is computed as follows (consumers must
use the identical algorithm):

1. `a = address.trim().toLowerCase()`
2. `slug = a` with every run of characters outside `[a-z0-9]` replaced by a
   single `-`, then leading and trailing `-` removed
3. `name = "mail-" + slug`
4. If `name` is longer than 63 characters:
   `name = name[:54].rstrip("-") + "-" + sha256_hex(a)[:8]`, where the hash is
   SHA-256 over the UTF-8 bytes of `a`, in lowercase hex.

Examples:

| Address | Queue |
| --- | --- |
| `hermes@example.org` | `mail-hermes-example-org` |
| `Hermes.Bot+x@Example.ORG` | `mail-hermes-bot-x-example-org` |
| 70 × `a` + `@example.org` | `mail-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-0ffad590` |

Every inbound queue gets one consumer of type `http_pull` with
`visibility_timeout_ms = 120000` and `max_retries = 5`; the Worker adds it on
the next email whenever it finds the queue without a consumer.

### Inbound queue message

Pushed with `content_type: "json"` to `mail-<slug>`:

```json
{
  "version": 1,
  "r2Key": "mail-hermes-example-org/2026-10-29T08:00:00.000Z-<uuid>.eml",
  "from": "<envelope MAIL FROM>",
  "to": "<envelope RCPT TO>",
  "receivedAt": "<ISO 8601>",
  "size": 12345
}
```

The object at `r2Key` in `email-agents` holds the raw message bytes
(`Content-Type: message/rfc822`, custom metadata `from` and `to`). The queue
consumer deletes the object once it has handled and acknowledged the message.

### Outbox queue message

Consumed from `email-outbox`:

```json
{
  "version": 1,
  "from": "hermes@example.org",
  "to": "author@example.com",
  "raw": "<base64 of the complete RFC 5322 message>"
}
```

`raw` is the finished message; the gateway sends the decoded bytes as-is with
`new EmailMessage(from, to, raw)`. `from` must be an address on the routing
domain and `to` a verified destination address.

### Logs

One JSON line per event: `queued`, `rejected` (inbound); `sent`,
`send_failed`, `discarded` (outbox); `cleanup_failed` if the R2 object could
not be removed after a rejected delivery.

## Operator setup

1. **Account resources**, once per account before the first deployment:

   ```sh
   npx wrangler queues create email-outbox
   npx wrangler queues create email-outbox-dlq
   npx wrangler r2 bucket create email-agents
   npx wrangler r2 bucket lifecycle add email-agents expire-agent-mail --expire-days 3
   ```

   The lifecycle rule is a safety net for mail whose queue entry expired
   before an unwrapper pulled it. Per-agent inbound queues are created by the
   Worker on the first email.
2. **Deploy**: either import this repository in **Workers & Pages → Create
   application → Import a repository** (Workers Builds; build command
   `npm run check && npm test`, deploy command `npx wrangler deploy`), or run
   `npm install && npx wrangler deploy` locally.
3. **Secrets** (Worker → Settings → Variables and Secrets, type Secret, or
   `npx wrangler secret put <name>`):
   - `CF_ACCOUNT_ID`: the account id that owns the queues;
   - `CF_API_TOKEN`: an API token with **Queues Edit** on that account.

   Both are secrets rather than `[vars]`, so deployments do not reset them.
4. **Observability**: Workers Logs are enabled in `wrangler.toml`.
5. **Email Routing**: on the mail domain, add one custom address rule per
   whitelisted agent address with the action "Send to a Worker" →
   `cf-email-gateway`. Do not use a catch-all rule.
6. **Recipients**: add every address that agents may reply to as a verified
   destination address in Email Routing; `send_email` only delivers to
   verified addresses.

## Limits

- A queue message is at most 128 KB. Inbound messages only carry a reference;
  replies larger than that cannot pass through `email-outbox`.
- Messages are retained for 24 hours on Workers Free (up to 14 days on Paid).
  Inbound mail not pulled within that window is lost from the queue (the R2
  object remains until the lifecycle rule removes it).
- Delivery is at least once and unordered.

## Development

```sh
nix develop      # optional: Node.js toolchain
npm install
npm run check    # tsc --noEmit
npm test         # vitest
```
