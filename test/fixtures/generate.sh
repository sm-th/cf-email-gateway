#!/usr/bin/env bash
# Regenerates the certificate-auth test fixtures: a test CA, a rogue CA, the
# key the tests issue guardian certificates for, and one guardian signature
# made with the OpenSSL command the guardian uses (fixed signingTime in
# guardian.sig.time, verified with that time as "now").
# Test-only keys, unencrypted on purpose. Requires OpenSSL 3.
set -euo pipefail

OPENSSL=${OPENSSL:-openssl}
cd "$(dirname "$0")"
rm -f ./*.pem ./*.b64 ./*.time
DAYS=36500

key() {
	"$OPENSSL" genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -pkeyopt ec_param_enc:named_curve -out "$1.key.pem"
}

# ca NAME CN
ca() {
	key "$1"
	"$OPENSSL" req -new -x509 -config /dev/null -key "$1.key.pem" -sha256 -days "$DAYS" -subj "/CN=$2" \
		-addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
		-addext "keyUsage=critical,keyCertSign,cRLSign" \
		-addext "subjectKeyIdentifier=hash" \
		-out "$1.crt.pem"
}

ca ca "Test Agent Root CA"
ca rogue-ca "Rogue Agent Root CA"
key guardian

ADDRESS=guardian@example.org
"$OPENSSL" req -new -config /dev/null -key guardian.key.pem -subj "/CN=guardian" |
	"$OPENSSL" x509 -req -CA ca.crt.pem -CAkey ca.key.pem -days "$DAYS" -sha256 \
		-extfile <(printf '%s\n' \
			"basicConstraints=critical,CA:FALSE" \
			"keyUsage=critical,digitalSignature" \
			"extendedKeyUsage=emailProtection" \
			"subjectAltName=email:$ADDRESS" \
			"subjectKeyIdentifier=hash" \
			"authorityKeyIdentifier=keyid:always") \
		-out guardian.crt.pem 2>/dev/null

challenge=$(mktemp)
signature=$(mktemp)
trap 'rm -f "$challenge" "$signature" ./*.srl' EXIT
printf 'cf-email-gateway mailbox v1\n%s\n' "$ADDRESS" >"$challenge"
date -u +%Y-%m-%dT%H:%M:%SZ >guardian.sig.time
"$OPENSSL" cms -sign -binary -md sha256 -outform DER -in "$challenge" \
	-signer guardian.crt.pem -inkey guardian.key.pem -out "$signature"
"$OPENSSL" base64 -A -in "$signature" >guardian.sig.b64
