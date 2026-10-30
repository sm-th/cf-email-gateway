import { errorMessage, log } from "./log";
import { ADDRESS_HEADER, type Env } from "./mailbox";

export { Mailbox } from "./mailbox";
export type { Env } from "./mailbox";

const REJECT_REASON = "Mailbox temporarily unavailable";
const MAILBOX_PATH = /^\/mailbox\/([^/]+)$/;

const encoder = new TextEncoder();

/** Checks `token` against lowercase hex HMAC-SHA256(secret, address) in constant time. */
async function tokenValid(secret: string, address: string, token: string): Promise<boolean> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(address)));
  const expected = encoder.encode(Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join(""));
  const given = encoder.encode(token);
  return given.byteLength === expected.byteLength && crypto.subtle.timingSafeEqual(given, expected);
}

export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const from = message.from;
    const to = message.to.trim().toLowerCase();
    try {
      const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
      const mailbox = env.MAILBOX.get(env.MAILBOX.idFromName(to));
      const id = await mailbox.deliver({ from, to, receivedAt: new Date().toISOString(), raw });
      log("received", { id, from, to, size: raw.byteLength });
    } catch (error) {
      log("rejected", { from, to, error: errorMessage(error) });
      message.setReject(REJECT_REASON);
    }
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const match = MAILBOX_PATH.exec(new URL(request.url).pathname);
    let address = "";
    try {
      address = match ? decodeURIComponent(match[1]).trim().toLowerCase() : "";
    } catch {
      // Malformed percent-encoding: treated as an unknown path.
    }
    if (!address) return new Response("Not found", { status: 404 });
    if (!env.GATEWAY_SECRET) return new Response("GATEWAY_SECRET is not configured", { status: 500 });

    const token = /^Bearer (.+)$/.exec(request.headers.get("Authorization") ?? "")?.[1] ?? "";
    if (!(await tokenValid(env.GATEWAY_SECRET, address, token))) return new Response("Unauthorized", { status: 401 });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426, headers: { Upgrade: "websocket" } });
    }

    const headers = new Headers(request.headers);
    headers.delete("Authorization");
    headers.set(ADDRESS_HEADER, address);
    return env.MAILBOX.get(env.MAILBOX.idFromName(address)).fetch(new Request(request, { headers }));
  },
} satisfies ExportedHandler<Env>;
