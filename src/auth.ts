import { BitString, GeneralizedTime, UTCTime } from "asn1js";
import { AltName, Certificate, ContentInfo, ExtKeyUsage, SignedData } from "pkijs";
import { errorMessage } from "./log";

/** Request header carrying the base64 DER CMS SignedData over the mailbox challenge. */
export const SIGNATURE_HEADER = "X-Mailbox-Signature";

/** How far signingTime may be from the gateway's clock, either way. */
export const SIGNING_TIME_TOLERANCE_MS = 5 * 60 * 1000;

const OID = {
  signedData: "1.2.840.113549.1.7.2",
  emailAddress: "1.2.840.113549.1.9.1",
  signingTime: "1.2.840.113549.1.9.5",
  keyUsage: "2.5.29.15",
  subjectAltName: "2.5.29.17",
  extKeyUsage: "2.5.29.37",
  emailProtection: "1.3.6.1.5.5.7.3.4",
} as const;

// digitalSignature is the first (most significant) bit of the KeyUsage BIT STRING.
const DIGITAL_SIGNATURE = 0x80;

/** The bytes a guardian signs to open `address`'s mailbox (lower-cased, trimmed). */
export function mailboxChallenge(address: string): Uint8Array<ArrayBuffer> {
  // TextEncoder always encodes into a fresh, non-shared ArrayBuffer.
  return new TextEncoder().encode(`cf-email-gateway mailbox v1\n${address}\n`) as Uint8Array<ArrayBuffer>;
}

/** Decodes base64 strictly: anything but base64 characters and padding is rejected. */
function base64Bytes(value: string): Uint8Array<ArrayBuffer> | undefined {
  const text = value.trim();
  if (!text || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return undefined;
  try {
    return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
  } catch {
    return undefined;
  }
}

/**
 * Trusted certificates from one or more PEM blocks. Whitespace inside a block
 * is ignored, so a single-line secret (newlines turned into spaces) works.
 * Throws when there is no parseable certificate.
 */
export function parseCaCertificates(pem: string): Certificate[] {
  const blocks = [...pem.matchAll(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g)];
  if (blocks.length === 0) throw new Error("CA_CERT contains no PEM certificate");
  return blocks.map((block) => {
    const der = base64Bytes(block[1].replace(/\s+/g, ""));
    if (!der) throw new Error("CA_CERT contains malformed base64");
    return Certificate.fromBER(der);
  });
}

function extension(certificate: Certificate, id: string): unknown {
  return certificate.extensions?.find((item) => item.extnID === id)?.parsedValue;
}

/** Lower-cased addresses from subjectAltName rfc822Name and the subject emailAddress. */
function certificateEmails(certificate: Certificate): Set<string> {
  const emails = new Set<string>();
  const alternativeNames = extension(certificate, OID.subjectAltName);
  if (alternativeNames instanceof AltName) {
    for (const name of alternativeNames.altNames) {
      if (name.type === 1 && typeof name.value === "string") emails.add(name.value.trim().toLowerCase());
    }
  }
  for (const attribute of certificate.subject.typesAndValues) {
    if (attribute.type === OID.emailAddress) emails.add(String(attribute.value.valueBlock.value).trim().toLowerCase());
  }
  return emails;
}

/** Why `certificate` may not authenticate `address`, or undefined when it may. */
function certificateProblem(certificate: Certificate, address: string): string | undefined {
  const usage = extension(certificate, OID.keyUsage);
  if (!(usage instanceof BitString) || ((usage.valueBlock.valueHexView[0] ?? 0) & DIGITAL_SIGNATURE) === 0) {
    return "signer certificate lacks keyUsage digitalSignature";
  }
  const purposes = extension(certificate, OID.extKeyUsage);
  if (!(purposes instanceof ExtKeyUsage) || !purposes.keyPurposes.includes(OID.emailProtection)) {
    return "signer certificate lacks extendedKeyUsage emailProtection";
  }
  if (!certificateEmails(certificate).has(address)) return "signer certificate is not issued for the mailbox address";
  return undefined;
}

function signingTime(signed: SignedData): Date | undefined {
  const attribute = signed.signerInfos[0].signedAttrs?.attributes.find((item) => item.type === OID.signingTime);
  const value = attribute?.values[0];
  return value instanceof UTCTime || value instanceof GeneralizedTime ? value.toDate() : undefined;
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

/**
 * Checks that `headerValue` (base64 DER CMS SignedData) is a detached
 * signature over `mailboxChallenge(address)` by a certificate that chains to
 * `trusted`, is valid at `now`, may sign email, and is issued for `address`,
 * with a signingTime within `SIGNING_TIME_TOLERANCE_MS` of `now`.
 * `address` must already be lower-cased and trimmed. No revocation checks.
 */
export async function verifyMailboxSignature(
  address: string,
  headerValue: string | null,
  trusted: Certificate[],
  now: Date,
): Promise<VerifyResult> {
  const fail = (reason: string): VerifyResult => ({ ok: false, reason });
  if (!headerValue) return fail(`missing ${SIGNATURE_HEADER} header`);
  const der = base64Bytes(headerValue);
  if (!der) return fail("signature is not base64");

  let signed: SignedData;
  try {
    const info = ContentInfo.fromBER(der);
    if (info.contentType !== OID.signedData) return fail("signature is not CMS SignedData");
    signed = new SignedData({ schema: info.content });
  } catch (error) {
    return fail(`malformed signature: ${errorMessage(error)}`);
  }
  if (signed.signerInfos.length !== 1) return fail("signature must have exactly one signer");
  // A signature with embedded content would be verified over that content, not over the challenge.
  if (signed.encapContentInfo.eContent) return fail("signature must be detached");

  let signer: Certificate | null | undefined;
  try {
    const result = await signed.verify({
      signer: 0,
      data: mailboxChallenge(address).buffer,
      trustedCerts: trusted,
      checkDate: now,
      checkChain: true,
      extendedMode: true,
    });
    if (!result.signatureVerified) return fail("signature does not verify over the mailbox challenge");
    signer = result.signerCertificate;
  } catch (error) {
    return fail(`signature is not valid: ${errorMessage(error)}`);
  }
  if (!signer) return fail("signature has no signer certificate");

  const problem = certificateProblem(signer, address);
  if (problem) return fail(problem);

  const time = signingTime(signed);
  if (!time) return fail("signature has no signingTime");
  if (Math.abs(time.getTime() - now.getTime()) > SIGNING_TIME_TOLERANCE_MS) {
    return fail(`signingTime ${time.toISOString()} is more than 5 minutes from now`);
  }
  return { ok: true };
}
