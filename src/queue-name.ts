const MAX_QUEUE_NAME_LENGTH = 63;

/**
 * Name of the inbound queue for an agent address. Must stay byte-for-byte
 * identical to the unwrapper's implementation (see README, "Queue naming").
 */
export async function queueName(address: string): Promise<string> {
  const normalized = address.trim().toLowerCase();
  const slug = normalized.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const name = `mail-${slug}`;
  if (name.length <= MAX_QUEUE_NAME_LENGTH) return name;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  const hash = Array.from(new Uint8Array(digest).subarray(0, 4), (b) => b.toString(16).padStart(2, "0")).join("");
  return `${name.slice(0, 54).replace(/-+$/, "")}-${hash}`;
}
