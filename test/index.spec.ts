import { evictDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SENDER = "author@example.com";
const INBOUND = "From: author@example.com\r\nTo: agent@example.org\r\nSubject: hi\r\n\r\nhello\r\n";

/** A fresh address per test, so no test sees another test's Mailbox. */
const freshAddress = () => `agent-${crypto.randomUUID()}@example.org`;

async function token(address: string, secret = "test-secret"): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(address)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Delivers inbound mail through the Worker's `email` handler. */
async function receive(to: string, raw: string | Uint8Array): Promise<void> {
  const setReject = vi.fn();
  const message = { from: SENDER, to, raw: new Response(raw).body!, setReject };
  await worker.email(message as unknown as ForwardableEmailMessage, env);
  expect(setReject).not.toHaveBeenCalled();
}

function concat(header: Record<string, unknown>, raw: string | Uint8Array): Uint8Array {
  const head = encoder.encode(`${JSON.stringify(header)}\n`);
  const body = typeof raw === "string" ? encoder.encode(raw) : raw;
  const frame = new Uint8Array(head.byteLength + body.byteLength);
  frame.set(head);
  frame.set(body, head.byteLength);
  return frame;
}

function parseMail(frame: string | ArrayBuffer): { header: Record<string, unknown>; raw: Uint8Array } {
  if (typeof frame === "string") throw new Error(`expected a binary frame, got ${frame}`);
  const bytes = new Uint8Array(frame);
  const newline = bytes.indexOf(0x0a);
  return { header: JSON.parse(decoder.decode(bytes.subarray(0, newline))), raw: bytes.subarray(newline + 1) };
}

/** A guardian-side WebSocket that queues incoming frames. */
class Guardian {
  private readonly frames: (string | ArrayBuffer)[] = [];
  private waiting?: () => void;
  readonly closed: Promise<CloseEvent>;

  constructor(readonly ws: WebSocket) {
    ws.accept();
    ws.addEventListener("message", (event) => {
      this.frames.push(event.data);
      this.waiting?.();
    });
    const closed = Promise.withResolvers<CloseEvent>();
    ws.addEventListener("close", closed.resolve);
    this.closed = closed.promise;
  }

  async next(): Promise<string | ArrayBuffer> {
    while (this.frames.length === 0) {
      const { promise, resolve } = Promise.withResolvers<void>();
      this.waiting = resolve;
      await promise;
    }
    return this.frames.shift()!;
  }

  async nextJson(): Promise<unknown> {
    const frame = await this.next();
    if (typeof frame !== "string") throw new Error("expected a text frame");
    return JSON.parse(frame);
  }

  /**
   * Returns every frame received before the reply to a probe frame. The
   * Mailbox handles one socket's frames in order, so earlier frames (and
   * all mail sent on connect) arrive first.
   */
  async drain(): Promise<(string | ArrayBuffer)[]> {
    this.ws.send("probe");
    const before: (string | ArrayBuffer)[] = [];
    for (;;) {
      const frame = await this.next();
      if (typeof frame === "string" && JSON.parse(frame).message === "expected an ack text frame") return before;
      before.push(frame);
    }
  }
}

function mailboxRequest(path: string, headers: Record<string, string>): Promise<Response> {
  return exports.default.fetch(new Request(`https://gateway.example${path}`, { headers }));
}

async function connect(address: string): Promise<Guardian> {
  const response = await mailboxRequest(`/mailbox/${encodeURIComponent(address)}`, {
    Upgrade: "websocket",
    Authorization: `Bearer ${await token(address)}`,
  });
  expect(response.status).toBe(101);
  return new Guardian(response.webSocket!);
}

describe("GET /mailbox/<address>", () => {
  it("rejects a wrong, foreign or missing token with 401", async () => {
    const address = freshAddress();
    const path = `/mailbox/${address}`;
    for (const authorization of [`Bearer ${await token(address, "other")}`, `Bearer ${await token(freshAddress())}`, ""]) {
      const response = await mailboxRequest(path, { Upgrade: "websocket", Authorization: authorization });
      expect(response.status).toBe(401);
    }
  });

  it("requires a WebSocket upgrade with 426", async () => {
    const address = freshAddress();
    const response = await mailboxRequest(`/mailbox/${address}`, { Authorization: `Bearer ${await token(address)}` });
    expect(response.status).toBe(426);
  });

  it("answers 404 outside /mailbox/<address>", async () => {
    for (const path of ["/", "/mailbox/", "/mailbox/a@example.org/x", "/other"]) {
      expect((await mailboxRequest(path, {})).status).toBe(404);
    }
  });

  it("answers 500 without GATEWAY_SECRET", async () => {
    const request = new Request("https://gateway.example/mailbox/a@example.org", { headers: { Upgrade: "websocket" } });
    const response = await worker.fetch(request, { ...env, GATEWAY_SECRET: undefined });
    expect(response.status).toBe(500);
  });

  it("normalizes a percent-encoded, mixed-case address before checking the token", async () => {
    const address = freshAddress();
    const response = await mailboxRequest(`/mailbox/${encodeURIComponent(` ${address.toUpperCase()} `)}`, {
      Upgrade: "websocket",
      Authorization: `Bearer ${await token(address)}`,
    });
    expect(response.status).toBe(101);
    response.webSocket!.accept();
    response.webSocket!.close();
  });
});

describe("inbound mail", () => {
  it("sends mail delivered before connecting on connect, with the exact header and bytes", async () => {
    const address = freshAddress();
    const before = Date.now();
    await receive(address.toUpperCase(), INBOUND);
    await receive(address, "second");

    const guardian = await connect(address);
    const first = parseMail(await guardian.next());
    expect(first.header).toEqual({
      type: "mail",
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      from: SENDER,
      to: address,
      receivedAt: expect.any(String),
      size: encoder.encode(INBOUND).byteLength,
    });
    expect(Date.parse(first.header.receivedAt as string)).toBeGreaterThanOrEqual(before - 1000);
    expect(decoder.decode(first.raw)).toBe(INBOUND);
    expect(decoder.decode(parseMail(await guardian.next()).raw)).toBe("second");
  });

  it("pushes mail that arrives while connected", async () => {
    const address = freshAddress();
    const guardian = await connect(address);
    await receive(address, INBOUND);
    const { header, raw } = parseMail(await guardian.next());
    expect(header).toMatchObject({ type: "mail", from: SENDER, to: address });
    expect(decoder.decode(raw)).toBe(INBOUND);
  });

  it("deletes acked mail and resends unacked mail on the next connection only", async () => {
    const address = freshAddress();
    await receive(address, "acked");
    await receive(address, "unacked");

    const first = await connect(address);
    const [acked, unacked] = (await first.drain()).map(parseMail);
    expect(decoder.decode(acked.raw)).toBe("acked");
    first.ws.send(JSON.stringify({ type: "ack", id: acked.header.id }));
    first.ws.send(JSON.stringify({ type: "ack", id: "unknown" }));
    expect(await first.drain()).toEqual([]);
    first.ws.close(1000);

    const second = await connect(address);
    const resent = (await second.drain()).map(parseMail);
    expect(resent.map((mail) => mail.header.id)).toEqual([unacked.header.id]);
  });

  it("round-trips mail larger than a SQLite row byte for byte", async () => {
    const address = freshAddress();
    const raw = new Uint8Array(2.5 * 1024 * 1024 + 7);
    for (let offset = 0; offset < raw.byteLength; offset += 65536) {
      crypto.getRandomValues(raw.subarray(offset, offset + 65536));
    }
    await receive(address, raw);

    const guardian = await connect(address);
    const mail = parseMail(await guardian.next());
    expect(mail.header.size).toBe(raw.byteLength);
    expect(mail.raw.byteLength).toBe(raw.byteLength);
    expect(mail.raw.every((byte, i) => byte === raw[i])).toBe(true);
  });

  it("drops mail older than 14 days when new mail arrives", async () => {
    const address = freshAddress();
    const stub = env.MAILBOX.get(env.MAILBOX.idFromName(address));
    const old = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
    await stub.deliver({ from: SENDER, to: address, receivedAt: old, raw: encoder.encode("old") });
    await receive(address, "new");

    const guardian = await connect(address);
    expect((await guardian.drain()).map((frame) => decoder.decode(parseMail(frame).raw))).toEqual(["new"]);
  });

  it("rejects the SMTP transaction when the Mailbox fails", async () => {
    const setReject = vi.fn();
    const message = { from: SENDER, to: "a@example.org", raw: new Response("x").body!, setReject };
    const failing = {
      idFromName: () => ({}),
      get: () => ({ deliver: () => Promise.reject(new Error("boom")) }),
    } as unknown as typeof env.MAILBOX;
    await worker.email(message as unknown as ForwardableEmailMessage, { ...env, MAILBOX: failing });
    expect(setReject).toHaveBeenCalledWith("Mailbox temporarily unavailable");
  });
});

describe("outbound mail", () => {
  const reply = (from: string, to: string) =>
    `From: ${from}\r\nTo: ${to}\r\nSubject: Re: hi\r\nMessage-ID: <${crypto.randomUUID()}@example.org>\r\n\r\nreply\r\n`;

  it("sends a reply with the mailbox address as envelope sender and answers sent", async () => {
    const address = freshAddress();
    const guardian = await connect(address);
    guardian.ws.send(concat({ type: "send", id: "r1", to: SENDER }, reply(address, SENDER)));
    expect(await guardian.nextJson()).toEqual({ type: "sent", id: "r1" });

    // The local send_email binding rejects a From: header that differs from
    // the envelope sender, so the envelope sender is the mailbox address.
    guardian.ws.send(concat({ type: "send", id: "r2", to: SENDER }, reply("other@example.org", SENDER)));
    expect(await guardian.nextJson()).toEqual({
      type: "error",
      id: "r2",
      message: expect.stringContaining("From: header does not match"),
    });
  });

  it("answers error when sending fails", async () => {
    const address = freshAddress();
    const guardian = await connect(address);
    const stranger = "stranger@example.net";
    guardian.ws.send(concat({ type: "send", id: "r1", to: stranger }, reply(address, stranger)));
    expect(await guardian.nextJson()).toEqual({ type: "error", id: "r1", message: `email to ${stranger} not allowed` });
  });

  it("still knows its address after eviction", async () => {
    const address = freshAddress();
    const guardian = await connect(address);
    await evictDurableObject(env.MAILBOX.get(env.MAILBOX.idFromName(address)));
    guardian.ws.send(concat({ type: "send", id: "r1", to: SENDER }, reply(address, SENDER)));
    expect(await guardian.nextJson()).toEqual({ type: "sent", id: "r1" });
  });

  it("answers unparseable frames with an error without id", async () => {
    const guardian = await connect(freshAddress());
    for (const frame of ["not json", JSON.stringify({ type: "send", id: "x" }), encoder.encode("no header")]) {
      guardian.ws.send(frame);
      expect(await guardian.nextJson()).toMatchObject({ type: "error", id: null });
    }
  });
});

describe("connections", () => {
  it("closes the older connection with 4000 replaced", async () => {
    const address = freshAddress();
    const first = await connect(address);
    const second = await connect(address);
    const event = await first.closed;
    expect([event.code, event.reason]).toEqual([4000, "replaced"]);

    await receive(address, INBOUND);
    expect(decoder.decode(parseMail(await second.next()).raw)).toBe(INBOUND);
  });
});
