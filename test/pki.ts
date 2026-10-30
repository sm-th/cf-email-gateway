/// <reference types="vite/client" />
import { BitString, Integer, ObjectIdentifier, OctetString, UTCTime, Utf8String, IA5String } from "asn1js";
import {
  AltName,
  Attribute,
  AttributeTypeAndValue,
  Certificate,
  ContentInfo,
  EncapsulatedContentInfo,
  ExtKeyUsage,
  Extension,
  GeneralName,
  IssuerAndSerialNumber,
  SignedAndUnsignedAttributes,
  SignedData,
  SignerInfo,
} from "pkijs";
import { mailboxChallenge } from "../src/auth";

const FIXTURES = import.meta.glob<string>("./fixtures/*.{pem,b64,time}", {
  query: "?raw",
  import: "default",
  eager: true,
});

export function fixture(name: string): string {
  const content = FIXTURES[`./fixtures/${name}`];
  if (content === undefined) throw new Error(`missing test fixture: ${name}`);
  return content;
}

function pemDer(pem: string): Uint8Array<ArrayBuffer> {
  const base64 = pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

export function certificate(name: string): Certificate {
  return Certificate.fromBER(pemDer(fixture(`${name}.crt.pem`)));
}

function privateKey(name: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("pkcs8", pemDer(fixture(`${name}.key.pem`)), { name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
  ]);
}

const OID = {
  data: "1.2.840.113549.1.7.1",
  signedData: "1.2.840.113549.1.7.2",
  emailAddress: "1.2.840.113549.1.9.1",
  contentType: "1.2.840.113549.1.9.3",
  messageDigest: "1.2.840.113549.1.9.4",
  signingTime: "1.2.840.113549.1.9.5",
  commonName: "2.5.4.3",
  keyUsage: "2.5.29.15",
  subjectAltName: "2.5.29.17",
  extKeyUsage: "2.5.29.37",
  emailProtection: "1.3.6.1.5.5.7.3.4",
  clientAuth: "1.3.6.1.5.5.7.3.2",
} as const;

export interface IssueOptions {
  /** Fixture CA that signs the certificate. */
  issuer?: "ca" | "rogue-ca";
  /** rfc822Name in subjectAltName; `null` leaves subjectAltName out. */
  altEmail?: string | null;
  /** emailAddress attribute in the subject DN. */
  subjectEmail?: string;
  /** First KeyUsage byte (0x80 digitalSignature, 0x08 keyAgreement). */
  keyUsage?: number;
  /** Extended key usages; defaults to emailProtection. */
  keyPurposes?: string[];
  notBefore?: Date;
  notAfter?: Date;
}

export const PURPOSE = { emailProtection: OID.emailProtection, clientAuth: OID.clientAuth } as const;

/** A guardian certificate for `address` with the fixture guardian key, issued by a fixture CA. */
export async function issueCertificate(address: string, options: IssueOptions = {}): Promise<Certificate> {
  const issuer = options.issuer ?? "ca";
  const cert = new Certificate();
  cert.version = 2;
  const serial = crypto.getRandomValues(new Uint8Array(16));
  serial[0] &= 0x7f;
  cert.serialNumber = new Integer({ valueHex: serial.buffer });
  cert.issuer = certificate(issuer).subject;
  cert.subject.typesAndValues.push(
    new AttributeTypeAndValue({ type: OID.commonName, value: new Utf8String({ value: "guardian" }) }),
  );
  if (options.subjectEmail) {
    cert.subject.typesAndValues.push(
      new AttributeTypeAndValue({ type: OID.emailAddress, value: new IA5String({ value: options.subjectEmail }) }),
    );
  }
  cert.notBefore.value = options.notBefore ?? new Date(Date.now() - 24 * 3600 * 1000);
  cert.notAfter.value = options.notAfter ?? new Date(Date.now() + 365 * 24 * 3600 * 1000);
  cert.subjectPublicKeyInfo = certificate("guardian").subjectPublicKeyInfo;

  const usage = options.keyUsage ?? 0x80;
  const extensions = [
    new Extension({
      extnID: OID.keyUsage,
      critical: true,
      extnValue: new BitString({ valueHex: new Uint8Array([usage]).buffer, unusedBits: 0 }).toBER(false),
    }),
    new Extension({
      extnID: OID.extKeyUsage,
      extnValue: new ExtKeyUsage({ keyPurposes: options.keyPurposes ?? [OID.emailProtection] }).toSchema().toBER(false),
    }),
  ];
  const altEmail = options.altEmail === undefined ? address : options.altEmail;
  if (altEmail !== null) {
    extensions.push(
      new Extension({
        extnID: OID.subjectAltName,
        extnValue: new AltName({ altNames: [new GeneralName({ type: 1, value: altEmail })] }).toSchema().toBER(false),
      }),
    );
  }
  cert.extensions = extensions;
  await cert.sign(await privateKey(issuer), "SHA-256");
  return cert;
}

export interface SignOptions {
  /** Signer certificate; must carry the fixture guardian key. Defaults to one issued for `address`. */
  signer?: Certificate;
  /** Omitted when `null`. */
  signingTime?: Date | null;
  /** Content to sign instead of the mailbox challenge for `address`. */
  content?: Uint8Array<ArrayBuffer>;
}

/** Base64 DER detached CMS SignedData, as the guardian's `openssl cms -sign` makes it. */
export async function signChallenge(address: string, options: SignOptions = {}): Promise<string> {
  const signer = options.signer ?? (await issueCertificate(address));
  const content = options.content ?? mailboxChallenge(address);
  const attributes = [
    new Attribute({ type: OID.contentType, values: [new ObjectIdentifier({ value: OID.data })] }),
    new Attribute({
      type: OID.messageDigest,
      values: [new OctetString({ valueHex: await crypto.subtle.digest("SHA-256", content) })],
    }),
  ];
  const signingTime = options.signingTime === undefined ? new Date() : options.signingTime;
  if (signingTime) {
    attributes.push(new Attribute({ type: OID.signingTime, values: [new UTCTime({ valueDate: signingTime })] }));
  }
  const signed = new SignedData({
    version: 1,
    encapContentInfo: new EncapsulatedContentInfo({ eContentType: OID.data }),
    signerInfos: [
      new SignerInfo({
        version: 1,
        sid: new IssuerAndSerialNumber({ issuer: signer.issuer, serialNumber: signer.serialNumber }),
        signedAttrs: new SignedAndUnsignedAttributes({ type: 0, attributes }),
      }),
    ],
    certificates: [signer],
  });
  await signed.sign(await privateKey("guardian"), 0, "SHA-256", content.buffer);
  const der = new ContentInfo({ contentType: OID.signedData, content: signed.toSchema(true) }).toSchema().toBER();
  return btoa(String.fromCharCode(...new Uint8Array(der)));
}
