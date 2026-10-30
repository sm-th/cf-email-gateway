import { describe, expect, it } from "vitest";
import { parseCaCertificates, verifyMailboxSignature } from "../src/auth";
import { fixture, issueCertificate, PURPOSE, signChallenge } from "./pki";

const trusted = parseCaCertificates(fixture("ca.crt.pem"));
const ADDRESS = "guardian@example.org";

describe("verifyMailboxSignature", () => {
  it("accepts the signature `openssl cms -sign` makes, as the guardian does", async () => {
    const signedAt = new Date(fixture("guardian.sig.time").trim());
    const signature = fixture("guardian.sig.b64");
    expect(await verifyMailboxSignature(ADDRESS, signature, trusted, signedAt)).toEqual({ ok: true });
    const later = new Date(signedAt.getTime() + 4 * 60_000);
    expect(await verifyMailboxSignature(ADDRESS, signature, trusted, later)).toEqual({ ok: true });
    const tooLate = new Date(signedAt.getTime() + 6 * 60_000);
    expect(await verifyMailboxSignature(ADDRESS, signature, trusted, tooLate)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/more than 5 minutes/),
    });
    expect(await verifyMailboxSignature("other@example.org", signature, trusted, signedAt)).toMatchObject({ ok: false });
  });

  it("matches the address against the subject emailAddress too, case-insensitively", async () => {
    const signer = await issueCertificate(ADDRESS, { altEmail: null, subjectEmail: "Guardian@Example.org" });
    const signature = await signChallenge(ADDRESS, { signer });
    expect(await verifyMailboxSignature(ADDRESS, signature, trusted, new Date())).toEqual({ ok: true });
  });

  it("rejects certificates that may not authenticate the mailbox", async () => {
    const day = 24 * 3600 * 1000;
    const cases: [string, Parameters<typeof issueCertificate>[1], RegExp][] = [
      ["no digitalSignature", { keyUsage: 0x08 }, /keyUsage digitalSignature/],
      ["no emailProtection", { keyPurposes: [PURPOSE.clientAuth] }, /extendedKeyUsage emailProtection/],
      ["no email address", { altEmail: null }, /not issued for the mailbox address/],
      [
        "expired",
        { notBefore: new Date(Date.now() - 10 * day), notAfter: new Date(Date.now() - day) },
        /signature is not valid/,
      ],
      ["not yet valid", { notBefore: new Date(Date.now() + day) }, /signature is not valid/],
    ];
    for (const [name, options, reason] of cases) {
      const signature = await signChallenge(ADDRESS, { signer: await issueCertificate(ADDRESS, options) });
      const result = await verifyMailboxSignature(ADDRESS, signature, trusted, new Date());
      expect(result, name).toEqual({ ok: false, reason: expect.stringMatching(reason) });
    }
  });

  it("rejects a signingTime in the future beyond 5 minutes", async () => {
    const signature = await signChallenge(ADDRESS, { signingTime: new Date(Date.now() + 6 * 60_000) });
    expect(await verifyMailboxSignature(ADDRESS, signature, trusted, new Date())).toEqual({
      ok: false,
      reason: expect.stringMatching(/more than 5 minutes/),
    });
  });
});
