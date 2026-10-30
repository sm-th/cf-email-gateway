import { EmailMessage } from "cloudflare:email";
import { DurableObject } from "cloudflare:workers";
import { errorMessage, log } from "./log";

export interface Env {
  MAILBOX: DurableObjectNamespace<Mailbox>;
  EMAIL: SendEmail;
  /** PEM certificate(s) of the CA that issues guardians' signing certificates. */
  CA_CERT?: string;
}

/** Inbound mail handed to {@link Mailbox.deliver} by the `email` handler. */
export interface InboundMail {
  from: string;
  /** The mailbox address, lowercased. */
  to: string;
  receivedAt: string;
  raw: Uint8Array;
}

/** Request header through which the Worker tells the Mailbox its address. */
export const ADDRESS_HEADER = "X-Mailbox-Address";

/** A SQLite row or BLOB is limited to 2 MB, so raw mail is stored in 1 MiB chunks. */
const CHUNK_SIZE = 1024 * 1024;
const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Encodes a binary frame: UTF-8 JSON header, "\n", raw bytes. */
function binaryFrame(header: unknown, size: number, writeBody: (body: Uint8Array) => void): Uint8Array {
  const head = encoder.encode(`${JSON.stringify(header)}\n`);
  const frame = new Uint8Array(head.byteLength + size);
  frame.set(head);
  writeBody(frame.subarray(head.byteLength));
  return frame;
}

function sendJson(ws: WebSocket, message: Record<string, unknown>): void {
  ws.send(JSON.stringify(message));
}

/**
 * Stores the mail of one agent address until the guardian acknowledges it,
 * and sends the guardian's replies through the `send_email` binding. The
 * guardian connects over a hibernatable WebSocket; at most one is kept.
 */
export class Mailbox extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS mail (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        sender TEXT NOT NULL,
        received_at TEXT NOT NULL,
        size INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chunk (
        mail_seq INTEGER NOT NULL,
        idx INTEGER NOT NULL,
        data BLOB NOT NULL,
        PRIMARY KEY (mail_seq, idx)
      );
    `);
  }

  /** Stores a mail and pushes it to the connected guardian, if any. Returns its id. */
  async deliver(mail: InboundMail): Promise<string> {
    this.rememberAddress(mail.to);
    const id = crypto.randomUUID();
    const { raw } = mail;
    const cutoff = new Date(Date.now() - RETENTION_MS).toISOString();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM chunk WHERE mail_seq IN (SELECT seq FROM mail WHERE received_at < ?)", cutoff);
      this.sql.exec("DELETE FROM mail WHERE received_at < ?", cutoff);
      const { seq } = this.sql
        .exec<{ seq: number }>(
          "INSERT INTO mail (id, sender, received_at, size) VALUES (?, ?, ?, ?) RETURNING seq",
          id,
          mail.from,
          mail.receivedAt,
          raw.byteLength,
        )
        .one();
      for (let offset = 0, idx = 0; offset < raw.byteLength; offset += CHUNK_SIZE, idx++) {
        const data = raw.buffer.slice(raw.byteOffset + offset, raw.byteOffset + Math.min(offset + CHUNK_SIZE, raw.byteLength));
        this.sql.exec("INSERT INTO chunk (mail_seq, idx, data) VALUES (?, ?, ?)", seq, idx, data);
      }
    });

    const frame = binaryFrame(
      { type: "mail", id, from: mail.from, to: mail.to, receivedAt: mail.receivedAt, size: raw.byteLength },
      raw.byteLength,
      (body) => body.set(raw),
    );
    // Replaced sockets stay listed until their closing handshake completes.
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      try {
        ws.send(frame);
      } catch (error) {
        log("push_failed", { mailbox: mail.to, id, error: errorMessage(error) });
      }
    }
    return id;
  }

  /** Accepts the guardian's WebSocket, replacing any older one, and sends all stored mail. */
  async fetch(request: Request): Promise<Response> {
    const address = request.headers.get(ADDRESS_HEADER);
    if (!address) return new Response("Missing mailbox address", { status: 400 });
    this.rememberAddress(address);

    for (const old of this.ctx.getWebSockets()) {
      if (old.readyState === WebSocket.OPEN) old.close(4000, "replaced");
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);

    const mails = this.sql
      .exec<{ seq: number; id: string; sender: string; received_at: string; size: number }>(
        "SELECT seq, id, sender, received_at, size FROM mail ORDER BY seq",
      )
      .toArray();
    for (const mail of mails) {
      const header = { type: "mail", id: mail.id, from: mail.sender, to: address, receivedAt: mail.received_at, size: mail.size };
      const frame = binaryFrame(header, mail.size, (body) => {
        let offset = 0;
        for (const { data } of this.sql.exec<{ data: ArrayBuffer }>(
          "SELECT data FROM chunk WHERE mail_seq = ? ORDER BY idx",
          mail.seq,
        )) {
          body.set(new Uint8Array(data), offset);
          offset += data.byteLength;
        }
      });
      server.send(frame);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message === "string") {
      const frame = parseJson(message);
      if (frame?.type === "ack" && typeof frame.id === "string") {
        this.ctx.storage.transactionSync(() => {
          this.sql.exec("DELETE FROM chunk WHERE mail_seq IN (SELECT seq FROM mail WHERE id = ?)", frame.id);
          this.sql.exec("DELETE FROM mail WHERE id = ?", frame.id);
        });
      } else {
        sendJson(ws, { type: "error", id: null, message: "expected an ack text frame" });
      }
      return;
    }

    const bytes = new Uint8Array(message);
    const newline = bytes.indexOf(0x0a);
    const header = newline < 0 ? undefined : parseJson(decoder.decode(bytes.subarray(0, newline)));
    if (header?.type !== "send" || typeof header.id !== "string") {
      sendJson(ws, { type: "error", id: null, message: "expected a send binary frame" });
      return;
    }
    const { id, to } = header;
    if (typeof to !== "string" || !to) {
      sendJson(ws, { type: "error", id, message: "missing recipient" });
      return;
    }
    const from = this.ctx.storage.kv.get<string>("address");
    const raw = bytes.subarray(newline + 1);
    try {
      if (!from) throw new Error("mailbox address unknown");
      await this.env.EMAIL.send(new EmailMessage(from, to, new Response(raw).body!));
      log("sent", { mailbox: from, id, to, size: raw.byteLength });
      sendJson(ws, { type: "sent", id });
    } catch (error) {
      log("send_failed", { mailbox: from, id, to, size: raw.byteLength, error: errorMessage(error) });
      sendJson(ws, { type: "error", id, message: errorMessage(error) });
    }
  }

  webSocketClose(ws: WebSocket, code: number): void {
    // Complete the closing handshake; 1005/1006 are reserved and cannot be sent.
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code);
    } catch {
      // Already closed.
    }
  }

  /** The address survives hibernation and eviction in storage. */
  private rememberAddress(address: string): void {
    if (this.ctx.storage.kv.get("address") !== address) this.ctx.storage.kv.put("address", address);
  }
}

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
