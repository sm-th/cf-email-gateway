import type { Certificate } from "pkijs";
import { parseCaCertificates, SIGNATURE_HEADER, verifyMailboxSignature } from "./auth";
import { errorMessage, log } from "./log";
import { ADDRESS_HEADER, type Env } from "./mailbox";

export { Mailbox } from "./mailbox";
export type { Env } from "./mailbox";

const REJECT_REASON = "Mailbox temporarily unavailable";
const MAILBOX_PATH = /^\/mailbox\/([^/]+)$/;

/** Parsed `CA_CERT`, kept while the secret is unchanged. */
let trust: { pem: string; certificates: Certificate[] } | undefined;

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
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426, headers: { Upgrade: "websocket" } });
    }
    if (!env.CA_CERT) return new Response("CA_CERT is not configured", { status: 500 });
    if (trust?.pem !== env.CA_CERT) {
      try {
        trust = { pem: env.CA_CERT, certificates: parseCaCertificates(env.CA_CERT) };
      } catch (error) {
        log("config_error", { error: errorMessage(error) });
        return new Response("CA_CERT is not a PEM certificate", { status: 500 });
      }
    }

    const signature = request.headers.get(SIGNATURE_HEADER);
    const verified = await verifyMailboxSignature(address, signature, trust.certificates, new Date());
    if (!verified.ok) {
      log("auth_failed", { address, reason: verified.reason });
      return new Response("unauthorized", { status: 401 });
    }

    const headers = new Headers(request.headers);
    headers.delete(SIGNATURE_HEADER);
    headers.set(ADDRESS_HEADER, address);
    return env.MAILBOX.get(env.MAILBOX.idFromName(address)).fetch(new Request(request, { headers }));
  },
} satisfies ExportedHandler<Env>;
