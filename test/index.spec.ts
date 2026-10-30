import { evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { mailboxChallenge } from "../src/auth";
import worker from "../src/index";
import { fixture, issueCertificate, signChallenge } from "./pki";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SENDER = "author@example.com";
const INBOUND = "From: author@example.com\r\nTo: agent@example.org\r\nSubject: hi\r\n\r\nhello\r\n";

/** A fresh address per test, so no test sees another test's Mailbox. */
const freshAddress = () => `agent-${crypto.randomUUID()}@example.org`;

const CA_CERT = fixture("ca.crt.pem");

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

/** A request through the Worker's `fetch` handler, with the test CA as `CA_CERT` unless `overrides` replace it. */
function mailboxRequest(path: string, headers: Record<string, string>, overrides: Partial<typeof env> = {}) {
  const request = new Request(`https://gateway.example${path}`, { headers });
  return worker.fetch(request, { ...env, CA_CERT, ...overrides });
}

/** The `auth_failed` reasons logged since `spy` was installed. */
function authFailures(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls
    .map(([line]) => JSON.parse(String(line)) as { event: string; reason?: string })
    .filter((entry) => entry.event === "auth_failed")
    .map((entry) => String(entry.reason));
}

async function connect(address: string): Promise<Guardian> {
  const response = await mailboxRequest(`/mailbox/${encodeURIComponent(address)}`, {
    Upgrade: "websocket",
    "X-Mailbox-Signature": await signChallenge(address),
  });
  expect(response.status).toBe(101);
  return new Guardian(response.webSocket!);
}

describe("GET /mailbox/<address>", () => {
  it("connects a guardian whose certificate the CA issued for the address, and delivers its mail", async () => {
    const address = freshAddress();
    const guardian = await connect(address);
    await receive(address, INBOUND);
    expect(decoder.decode(parseMail(await guardian.next()).raw)).toBe(INBOUND);
  });

  it("rejects a missing or invalid signature with 401 and logs why", async () => {
    const address = freshAddress();
    const other = freshAddress();
    const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
    const cases: [string, string | undefined, RegExp][] = [
      ["missing header", undefined, /missing X-Mailbox-Signature/],
      ["not base64", "%%%", /not base64/],
      ["not CMS", btoa("hello"), /malformed signature/],
      [
        "certificate for another address",
        await signChallenge(address, { signer: await issueCertificate(other) }),
        /not issued for the mailbox address/,
      ],
      [
        "certificate from another CA",
        await signChallenge(address, { signer: await issueCertificate(address, { issuer: "rogue-ca" }) }),
        /signature is not valid/,
      ],
      [
        "signature over another address",
        await signChallenge(address, { content: mailboxChallenge(other) }),
        /signature is not valid: .*digest/,
      ],
      ["stale signingTime", await signChallenge(address, { signingTime: minutesAgo(6) }), /more than 5 minutes/],
      ["no signingTime", await signChallenge(address, { signingTime: null }), /no signingTime/],
    ];
    for (const [name, signature, reason] of cases) {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const headers: Record<string, string> = { Upgrade: "websocket" };
      if (signature !== undefined) headers["X-Mailbox-Signature"] = signature;
      const response = await mailboxRequest(`/mailbox/${address}`, headers);
      expect(response.status, name).toBe(401);
      expect(await response.text(), name).toBe("unauthorized");
      expect(authFailures(error), name).toEqual([expect.stringMatching(reason)]);
      error.mockRestore();
    }
  });

  it("requires a WebSocket upgrade with 426", async () => {
    const address = freshAddress();
    const response = await mailboxRequest(`/mailbox/${address}`, { "X-Mailbox-Signature": await signChallenge(address) });
    expect(response.status).toBe(426);
  });

  it("answers 404 outside /mailbox/<address>", async () => {
    for (const path of ["/", "/mailbox/", "/mailbox/a@example.org/x", "/other"]) {
      expect((await mailboxRequest(path, {})).status).toBe(404);
    }
  });

  it("answers 500 without a usable CA_CERT", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const address = freshAddress();
    const headers = { Upgrade: "websocket", "X-Mailbox-Signature": await signChallenge(address) };
    for (const caCert of [undefined, "", "not a certificate", "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----"]) {
      expect((await mailboxRequest(`/mailbox/${address}`, headers, { CA_CERT: caCert })).status).toBe(500);
    }
  });

  it("accepts a single-line CA_CERT and a CA_CERT with several certificates", async () => {
    const address = freshAddress();
    const singleLine = CA_CERT.trim().replace(/\n/g, " ");
    const bundle = `${fixture("rogue-ca.crt.pem")}${CA_CERT}`;
    for (const caCert of [singleLine, bundle]) {
      const headers = { Upgrade: "websocket", "X-Mailbox-Signature": await signChallenge(address) };
      const response = await mailboxRequest(`/mailbox/${address}`, headers, { CA_CERT: caCert });
      expect(response.status).toBe(101);
      response.webSocket!.accept();
      response.webSocket!.close();
    }
  });

  it("normalizes a percent-encoded, mixed-case address before checking the signature", async () => {
    const address = freshAddress();
    const response = await mailboxRequest(`/mailbox/${encodeURIComponent(` ${address.toUpperCase()} `)}`, {
      Upgrade: "websocket",
      "X-Mailbox-Signature": await signChallenge(address),
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
