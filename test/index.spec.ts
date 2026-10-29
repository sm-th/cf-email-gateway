import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { Env } from "../src/index";
import { EmailMessage } from "./cloudflare-email";

const ACCOUNT = "acc123";
const TOKEN = "token-xyz";
const NOW = "2026-10-29T08:00:00.000Z";
const UUID = "11111111-2222-4333-8444-555555555555";
const PULL = [{ type: "http_pull" }];
const WORKER_CONSUMER = {
  type: "worker",
  script_name: "cf-email-gateway",
  dead_letter_queue: "email-outbox-dlq",
  settings: { batch_size: 10, max_retries: 5 },
};

/** Fresh module per test, so the per-isolate queue id cache starts empty. */
let worker: typeof import("../src/index").default;
beforeEach(async () => {
  vi.resetModules();
  worker = (await import("../src/index")).default;
});
const RAW = "From: author@example.com\r\nTo: hermes@example.org\r\nSubject: hi\r\n\r\nhello\r\n";

interface FakeQueue {
  queue_id: string;
  queue_name: string;
  consumers?: { type: string }[];
}

interface ApiRequest {
  method: string;
  path: string;
  body: unknown;
  authorization: string | null;
}

/** In-memory Cloudflare Queues API served through a stubbed global fetch. */
function fakeCloudflare(options: {
  queues?: FakeQueue[];
  /**
   * State of email-outbox and email-outbox-dlq: "ready" (default) has both,
   * the outbox with its Worker consumer; "bare" has both without consumers;
   * "missing" has neither.
   */
  outbox?: "ready" | "bare" | "missing";
  /** Another isolate creates the queue right before our create call. */
  createConflict?: boolean;
  pushError?: string;
  consumerError?: string;
}) {
  const outbox = options.outbox ?? "ready";
  const queues: FakeQueue[] = [
    ...(outbox === "missing"
      ? []
      : [
          { queue_id: "q-dlq", queue_name: "email-outbox-dlq", consumers: [] },
          { queue_id: "q-outbox", queue_name: "email-outbox", consumers: outbox === "ready" ? [{ type: "worker" }] : [] },
        ]),
    ...(options.queues ?? []),
  ];
  const requests: ApiRequest[] = [];
  const reply = (status: number, result: unknown, errors: { code: number; message: string }[] = []) =>
    new Response(JSON.stringify({ success: status < 400, errors, messages: [], result }), { status });

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = new URL(input);
      const prefix = `/client/v4/accounts/${ACCOUNT}`;
      expect(url.origin + url.pathname.slice(0, prefix.length)).toBe(`https://api.cloudflare.com${prefix}`);
      const path = url.pathname.slice(prefix.length);
      const method = init.method ?? "GET";
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ method, path, body, authorization: new Headers(init.headers).get("authorization") });

      if (method === "GET" && path === "/queues") return reply(200, queues);
      const consumersPath = /^\/queues\/([^/]+)\/consumers$/.exec(path);
      if (method === "POST" && consumersPath) {
        if (options.consumerError) return reply(500, null, [{ code: 10001, message: options.consumerError }]);
        queues.find((q) => q.queue_id === consumersPath[1])?.consumers?.push({ type: body.type });
        return reply(200, { consumer_id: "c1" });
      }
      if (method === "POST" && path === "/queues") {
        if (options.createConflict) {
          queues.push({ queue_id: "q-other", queue_name: body.queue_name, consumers: [{ type: "http_pull" }] });
          return reply(409, null, [{ code: 11009, message: "A queue with this name already exists" }]);
        }
        const created = { queue_id: `new-${body.queue_name}`, queue_name: body.queue_name, consumers: [] };
        queues.push(created);
        return reply(200, created);
      }
      if (method === "POST" && /^\/queues\/[^/]+\/messages$/.test(path)) {
        return options.pushError ? reply(500, null, [{ code: 10001, message: options.pushError }]) : reply(200, null);
      }
      return reply(404, null, [{ code: 7003, message: `unexpected ${method} ${path}` }]);
    }),
  );
  return requests;
}

function fakeBucket() {
  const objects = new Map<string, { bytes: Uint8Array; options: R2PutOptions | undefined }>();
  const bucket = {
    put: vi.fn(async (key: string, value: Uint8Array, options?: R2PutOptions) => {
      objects.set(key, { bytes: value, options });
    }),
    delete: vi.fn(async (key: string) => {
      objects.delete(key);
    }),
  };
  return { objects, bucket };
}

interface FakeInboundEmail {
  from: string;
  to: string;
  raw: ReadableStream;
  rawSize: number;
  setReject: Mock;
}

function inboundEmail(to: string): FakeInboundEmail {
  return {
    from: "author@example.com",
    to,
    raw: new Response(RAW).body!,
    rawSize: RAW.length,
    setReject: vi.fn(),
  };
}

function env(bucket: unknown, send?: (m: EmailMessage) => Promise<unknown>): Env {
  return {
    AGENT_MAIL: bucket as R2Bucket,
    EMAIL: { send: vi.fn(send ?? (async () => ({}))) } as unknown as SendEmail,
    CF_ACCOUNT_ID: ACCOUNT,
    CF_API_TOKEN: TOKEN,
  };
}

/** Drops the two outbox lookups that precede every first email in an isolate. */
function afterOutboxLookups(requests: ApiRequest[]): ApiRequest[] {
  expect(requests.slice(0, 2).map((r) => `${r.method} ${r.path}`)).toEqual(["GET /queues", "GET /queues"]);
  return requests.slice(2);
}

async function receive(message: FakeInboundEmail, environment: Env) {
  await worker.email(message as unknown as ForwardableEmailMessage, environment);
}

describe("email handler", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    vi.spyOn(crypto, "randomUUID").mockReturnValue(UUID);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stores the message and pushes the contract body to an existing queue", async () => {
    const requests = fakeCloudflare({ queues: [{ queue_id: "q-hermes", queue_name: "mail-hermes-example-org", consumers: PULL }] });
    const { objects, bucket } = fakeBucket();
    const message = inboundEmail("Hermes@Example.org");

    await receive(message, env(bucket));

    const key = `mail-hermes-example-org/${NOW}-${UUID}.eml`;
    const stored = objects.get(key);
    expect(new TextDecoder().decode(stored?.bytes)).toBe(RAW);
    expect(stored?.options).toEqual({
      httpMetadata: { contentType: "message/rfc822" },
      customMetadata: { from: "author@example.com", to: "Hermes@Example.org" },
    });
    const pushes = requests.filter((r) => r.path.endsWith("/messages"));
    expect(pushes).toEqual([
      {
        method: "POST",
        path: "/queues/q-hermes/messages",
        authorization: `Bearer ${TOKEN}`,
        body: {
          content_type: "json",
          body: {
            version: 1,
            r2Key: key,
            from: "author@example.com",
            to: "Hermes@Example.org",
            receivedAt: NOW,
            size: RAW.length,
          },
        },
      },
    ]);
    expect(requests.some((r) => r.method === "POST" && r.path.endsWith("/consumers"))).toBe(false);
    expect(requests.some((r) => r.method === "POST" && r.path === "/queues")).toBe(false);
    expect(message.setReject).not.toHaveBeenCalled();
  });

  it("caches the queue id so later emails skip the lookup", async () => {
    const requests = fakeCloudflare({ queues: [{ queue_id: "q-cache", queue_name: "mail-cache-example-org", consumers: PULL }] });
    const { bucket } = fakeBucket();

    await receive(inboundEmail("cache@example.org"), env(bucket));
    await receive(inboundEmail("cache@example.org"), env(bucket));

    expect(afterOutboxLookups(requests).map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /queues",
      "POST /queues/q-cache/messages",
      "POST /queues/q-cache/messages",
    ]);
  });

  it("creates a missing queue with an http_pull consumer before pushing", async () => {
    const requests = fakeCloudflare({ queues: [{ queue_id: "q-x", queue_name: "mail-someone-else" }] });
    const { objects, bucket } = fakeBucket();
    const message = inboundEmail("newbot@example.org");

    await receive(message, env(bucket));

    expect(afterOutboxLookups(requests).map((r) => [r.method, r.path, r.body])).toEqual([
      ["GET", "/queues", undefined],
      ["POST", "/queues", { queue_name: "mail-newbot-example-org" }],
      [
        "POST",
        "/queues/new-mail-newbot-example-org/consumers",
        { type: "http_pull", settings: { visibility_timeout_ms: 120000, max_retries: 5 } },
      ],
      ["POST", "/queues/new-mail-newbot-example-org/messages", expect.objectContaining({ content_type: "json" })],
    ]);
    expect(objects.size).toBe(1);
    expect(message.setReject).not.toHaveBeenCalled();
  });

  it("adds the missing http_pull consumer to an existing queue and caches only afterwards", async () => {
    const requests = fakeCloudflare({ queues: [{ queue_id: "q-bare", queue_name: "mail-bare-example-org", consumers: [] }] });
    const { bucket } = fakeBucket();

    await receive(inboundEmail("bare@example.org"), env(bucket));
    await receive(inboundEmail("bare@example.org"), env(bucket));

    expect(afterOutboxLookups(requests).map((r) => [r.method, r.path, r.body])).toEqual([
      ["GET", "/queues", undefined],
      [
        "POST",
        "/queues/q-bare/consumers",
        { type: "http_pull", settings: { visibility_timeout_ms: 120000, max_retries: 5 } },
      ],
      ["POST", "/queues/q-bare/messages", expect.anything()],
      ["POST", "/queues/q-bare/messages", expect.anything()],
    ]);
  });

  it("retries the consumer setup on the next email when adding it failed", async () => {
    const queues = [{ queue_id: "q-flaky", queue_name: "mail-flaky-example-org", consumers: [] as { type: string }[] }];
    const requests = fakeCloudflare({ queues, consumerError: "temporary outage" });
    const { bucket } = fakeBucket();
    const first = inboundEmail("flaky@example.org");

    await receive(first, env(bucket));
    expect(first.setReject).toHaveBeenCalledOnce();

    const requests2 = fakeCloudflare({ queues });
    const second = inboundEmail("flaky@example.org");
    await receive(second, env(bucket));

    expect(second.setReject).not.toHaveBeenCalled();
    expect(requests.filter((r) => r.path.endsWith("/messages"))).toEqual([]);
    expect(requests2.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /queues",
      "POST /queues/q-flaky/consumers",
      "POST /queues/q-flaky/messages",
    ]);
  });

  it("creates the outbox queues and the agent queue on the first email into an empty account", async () => {
    const requests = fakeCloudflare({ outbox: "missing" });
    const { bucket } = fakeBucket();
    const message = inboundEmail("first@example.org");

    await receive(message, env(bucket));

    expect(requests.map((r) => [r.method, r.path, r.body])).toEqual([
      ["GET", "/queues", undefined],
      ["POST", "/queues", { queue_name: "email-outbox-dlq" }],
      ["GET", "/queues", undefined],
      ["POST", "/queues", { queue_name: "email-outbox" }],
      ["POST", "/queues/new-email-outbox/consumers", WORKER_CONSUMER],
      ["GET", "/queues", undefined],
      ["POST", "/queues", { queue_name: "mail-first-example-org" }],
      [
        "POST",
        "/queues/new-mail-first-example-org/consumers",
        { type: "http_pull", settings: { visibility_timeout_ms: 120000, max_retries: 5 } },
      ],
      ["POST", "/queues/new-mail-first-example-org/messages", expect.objectContaining({ content_type: "json" })],
    ]);
    expect(message.setReject).not.toHaveBeenCalled();
  });

  it("adds the Worker consumer to an existing outbox queue that has none", async () => {
    const requests = fakeCloudflare({
      outbox: "bare",
      queues: [{ queue_id: "q-agent", queue_name: "mail-agent-example-org", consumers: PULL }],
    });
    const { bucket } = fakeBucket();

    await receive(inboundEmail("agent@example.org"), env(bucket));

    expect(requests.filter((r) => r.path.endsWith("/consumers")).map((r) => [r.path, r.body])).toEqual([
      ["/queues/q-outbox/consumers", WORKER_CONSUMER],
    ]);
  });

  it("rejects the email when the outbox queue cannot be set up", async () => {
    const requests = fakeCloudflare({ outbox: "bare", consumerError: "not allowed" });
    const { objects, bucket } = fakeBucket();
    const message = inboundEmail("agent@example.org");

    await receive(message, env(bucket));

    expect(message.setReject).toHaveBeenCalledOnce();
    expect(objects.size).toBe(0);
    expect(requests.some((r) => r.path.endsWith("/messages"))).toBe(false);
  });

  it("uses the queue created concurrently by another isolate when create conflicts", async () => {
    const requests = fakeCloudflare({ createConflict: true });
    const { objects, bucket } = fakeBucket();
    const message = inboundEmail("racer@example.org");

    await receive(message, env(bucket));

    expect(afterOutboxLookups(requests).map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /queues",
      "POST /queues",
      "GET /queues",
      "POST /queues/q-other/messages",
    ]);
    expect(objects.size).toBe(1);
    expect(message.setReject).not.toHaveBeenCalled();
  });

  it("deletes the stored object and rejects when the push fails", async () => {
    fakeCloudflare({
      queues: [{ queue_id: "q-fail", queue_name: "mail-fail-example-org", consumers: PULL }],
      pushError: "Queue is overloaded",
    });
    const { objects, bucket } = fakeBucket();
    const message = inboundEmail("fail@example.org");

    await receive(message, env(bucket));

    expect(bucket.put).toHaveBeenCalledOnce();
    expect(bucket.delete).toHaveBeenCalledWith(`mail-fail-example-org/${NOW}-${UUID}.eml`);
    expect(objects.size).toBe(0);
    expect(message.setReject).toHaveBeenCalledOnce();
    const logged = vi.mocked(console.error).mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(logged).toContainEqual(
      expect.objectContaining({ event: "rejected", error: expect.stringContaining("10001: Queue is overloaded") }),
    );
  });
});

describe("outbox consumer", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  interface FakeQueueMessage {
    id: string;
    timestamp: Date;
    body: unknown;
    attempts: number;
    ack: Mock;
    retry: Mock;
  }

  function queueMessage(body: unknown): FakeQueueMessage {
    return { id: "m1", timestamp: new Date(), body, attempts: 1, ack: vi.fn(), retry: vi.fn() };
  }

  async function consume(message: FakeQueueMessage, environment: Env) {
    const batch = { queue: "email-outbox", messages: [message] } as unknown as MessageBatch<unknown>;
    await worker.queue(batch, environment);
  }

  const reply = "From: hermes@example.org\r\nTo: author@example.com\r\n\r\n\u00e9\u00ff body\r\n";
  const replyBytes = Uint8Array.from(reply, (c) => c.charCodeAt(0));
  const validBody = {
    version: 1,
    from: "hermes@example.org",
    to: "author@example.com",
    raw: btoa(reply),
  };

  it("sends the decoded raw message unchanged and acks", async () => {
    const sent: EmailMessage[] = [];
    const environment = env(undefined, async (m) => sent.push(m));
    const message = queueMessage(validBody);

    await consume(message, environment);

    expect(sent).toHaveLength(1);
    expect(sent[0].from).toBe("hermes@example.org");
    expect(sent[0].to).toBe("author@example.com");
    expect(new Uint8Array(await new Response(sent[0].raw).arrayBuffer())).toEqual(replyBytes);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it.each([
    ["not an object", "hello"],
    ["wrong version", { ...validBody, version: 2 }],
    ["missing recipient", { ...validBody, to: "" }],
    ["invalid base64", { ...validBody, raw: "@@not base64@@" }],
  ])("acks without sending when the body is invalid (%s)", async (_, body) => {
    const environment = env(undefined);
    const message = queueMessage(body);

    await consume(message, environment);

    expect(environment.EMAIL.send).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("retries when sending fails", async () => {
    const environment = env(undefined, async () => {
      throw new Error("destination address not verified");
    });
    const message = queueMessage(validBody);

    await consume(message, environment);

    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
    const logged = vi.mocked(console.error).mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(logged).toContainEqual(expect.objectContaining({ event: "send_failed" }));
  });
});
