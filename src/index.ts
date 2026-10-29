import { EmailMessage } from "cloudflare:email";
import { ensureQueue, pushMessage, type QueuesApiConfig } from "./cloudflare-queues";
import { queueName } from "./queue-name";

export interface Env {
  INBOX: R2Bucket;
  EMAIL: SendEmail;
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
}

/** Message pushed to an agent's inbound queue `mail-<slug>`. */
export interface InboundMessage {
  version: 1;
  r2Key: string;
  from: string;
  to: string;
  receivedAt: string;
  size: number;
}

/** Message consumed from the `email-outbox` queue. */
export interface OutboxMessage {
  version: 1;
  from: string;
  to: string;
  /** Base64 of the complete RFC 5322 message. */
  raw: string;
}

const REJECT_REASON = "Mailbox temporarily unavailable";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function log(event: string, fields: Record<string, unknown>): void {
  const line = JSON.stringify({ event, ...fields });
  if (event === "rejected" || event === "send_failed" || event === "discarded") console.error(line);
  else console.log(line);
}

/** Decodes a valid outbox body into raw message bytes, or returns undefined. */
function parseOutbox(body: unknown): { from: string; to: string; raw: Uint8Array } | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const { version, from, to, raw } = body as Partial<Record<keyof OutboxMessage, unknown>>;
  if (version !== 1) return undefined;
  if (typeof from !== "string" || !from || typeof to !== "string" || !to) return undefined;
  if (typeof raw !== "string" || !raw) return undefined;
  let binary: string;
  try {
    binary = atob(raw);
  } catch {
    return undefined;
  }
  return { from, to, raw: Uint8Array.from(binary, (c) => c.charCodeAt(0)) };
}

export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const { from, to } = message;
    let r2Key: string | undefined;
    try {
      const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
      const queue = await queueName(to);
      const receivedAt = new Date().toISOString();
      const key = `inbox/${queue}/${receivedAt}-${crypto.randomUUID()}.eml`;
      await env.INBOX.put(key, raw, {
        httpMetadata: { contentType: "message/rfc822" },
        customMetadata: { from, to },
      });
      r2Key = key;

      const api: QueuesApiConfig = { accountId: env.CF_ACCOUNT_ID, apiToken: env.CF_API_TOKEN };
      const queueId = await ensureQueue(api, queue);
      const body: InboundMessage = { version: 1, r2Key: key, from, to, receivedAt, size: raw.byteLength };
      await pushMessage(api, queueId, body);
      log("queued", { from, to, queue, r2Key: key, size: raw.byteLength });
    } catch (error) {
      if (r2Key) {
        try {
          await env.INBOX.delete(r2Key);
        } catch (deleteError) {
          log("cleanup_failed", { r2Key, error: errorMessage(deleteError) });
        }
      }
      log("rejected", { from, to, error: errorMessage(error) });
      message.setReject(REJECT_REASON);
    }
  },

  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const outbox = parseOutbox(message.body);
      if (!outbox) {
        log("discarded", { id: message.id, error: "invalid outbox message" });
        message.ack();
        continue;
      }
      const { from, to, raw } = outbox;
      try {
        await env.EMAIL.send(new EmailMessage(from, to, new Response(raw).body!));
        log("sent", { id: message.id, from, to, size: raw.byteLength });
        message.ack();
      } catch (error) {
        log("send_failed", { id: message.id, from, to, attempts: message.attempts, error: errorMessage(error) });
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<Env>;
