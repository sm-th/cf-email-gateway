import { describe, expect, it } from "vitest";
import { queueName } from "../src/queue-name";

// Expected values for long names were computed with the contract's reference
// algorithm in Python (hashlib.sha256), which the unwrapper implements.
describe("queueName", () => {
  it.each([
    ["hermes@example.org", "mail-hermes-example-org"],
    ["Hermes.Bot+x@Example.ORG", "mail-hermes-bot-x-example-org"],
    ["  Hermes@Example.org \n", "mail-hermes-example-org"],
    ["--a..b@@c--", "mail-a-b-c"],
  ])("slugifies %j", async (address, expected) => {
    expect(await queueName(address)).toBe(expected);
  });

  it("shortens a 70-character local part to 63 characters with a hash suffix", async () => {
    const name = await queueName(`${"a".repeat(70)}@example.org`);
    expect(name).toBe("mail-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-0ffad590");
    expect(name).toHaveLength(63);
  });

  it("strips a trailing dash at the cut point before appending the hash", async () => {
    const name = await queueName(`${"x".repeat(48)}.yyyyyyyyyy@example.com`);
    expect(name).toBe(`mail-${"x".repeat(48)}-c25175c1`);
  });

  it("keeps names of exactly 63 characters unhashed", async () => {
    const local = "b".repeat(63 - "mail-".length - "-ex-com".length);
    expect(await queueName(`${local}@ex.com`)).toBe(`mail-${local}-ex-com`);
  });
});
