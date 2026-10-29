const API_BASE = "https://api.cloudflare.com/client/v4";

export interface QueuesApiConfig {
  accountId: string;
  apiToken: string;
}

interface CloudflareEnvelope<T> {
  success: boolean;
  errors?: { code?: number; message?: string }[];
  result: T;
  result_info?: { page?: number; total_pages?: number };
}

interface QueueInfo {
  queue_id: string;
  queue_name: string;
  consumers?: { type?: string }[];
}

/** Queue ids by `<account>/<name>`, cached for the lifetime of the isolate. */
const queueIds = new Map<string, string>();

async function call<T>(
  config: QueuesApiConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<CloudflareEnvelope<T>> {
  if (!config.accountId || !config.apiToken) {
    throw new Error("CF_ACCOUNT_ID and CF_API_TOKEN must be configured");
  }
  const response = await fetch(`${API_BASE}/accounts/${config.accountId}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.apiToken}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let envelope: CloudflareEnvelope<T> | undefined;
  try {
    envelope = (await response.json()) as CloudflareEnvelope<T>;
  } catch {
    envelope = undefined;
  }
  if (!response.ok || !envelope?.success) {
    const messages = envelope?.errors?.map((e) => (e.code ? `${e.code}: ${e.message}` : e.message)).join("; ");
    throw new Error(`Cloudflare API ${method} ${path} failed (HTTP ${response.status}): ${messages || "no error details"}`);
  }
  return envelope;
}

async function findQueue(config: QueuesApiConfig, name: string): Promise<QueueInfo | undefined> {
  for (let page = 1; ; page++) {
    const { result, result_info } = await call<QueueInfo[]>(config, "GET", `/queues?page=${page}`);
    const match = result.find((q) => q.queue_name === name);
    if (match) return match;
    if (!result_info?.total_pages || page >= result_info.total_pages) return undefined;
  }
}

/**
 * Returns the id of queue `name`, creating it when missing and adding the
 * http_pull consumer when the queue has none. Ids are cached only once the
 * consumer is known to exist, so a half-finished setup is repaired by the
 * next email.
 */
export async function ensureQueue(config: QueuesApiConfig, name: string): Promise<string> {
  const cacheKey = `${config.accountId}/${name}`;
  const cached = queueIds.get(cacheKey);
  if (cached) return cached;

  let queue = await findQueue(config, name);
  if (!queue) {
    try {
      queue = (await call<QueueInfo>(config, "POST", "/queues", { queue_name: name })).result;
    } catch (createError) {
      // A concurrent first email may have created it between list and create.
      queue = await findQueue(config, name);
      if (!queue) throw createError;
    }
  }
  if (!queue.consumers?.length) {
    try {
      await call(config, "POST", `/queues/${queue.queue_id}/consumers`, {
        type: "http_pull",
        settings: { visibility_timeout_ms: 120000, max_retries: 5 },
      });
    } catch (consumerError) {
      // A concurrent email may have added the consumer first.
      if (!(await findQueue(config, name))?.consumers?.length) throw consumerError;
    }
  }
  queueIds.set(cacheKey, queue.queue_id);
  return queue.queue_id;
}

export async function pushMessage(config: QueuesApiConfig, queueId: string, body: unknown): Promise<void> {
  await call(config, "POST", `/queues/${queueId}/messages`, { body, content_type: "json" });
}
