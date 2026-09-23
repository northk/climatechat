/**
 * SPIKE — App Attest certificate chain validator, hand-rolled over native
 * WebCrypto (app-attest-design.md §12 Q3).
 *
 * Unlike src/spikeCounter.ts this file is INTENDED FOR PROMOTION: it is the
 * candidate implementation, exercised by test/spike-chain.spec.ts.
 *
 * Scope is deliberately narrow — App Attest's chain is always exactly
 * leaf -> Apple intermediate -> pinned Apple root, with known algorithms.
 * This is not, and must not become, a general PKI library.
 *
 * Revocation (CRL/OCSP) is deliberately NOT checked: Apple's leaf
 * certificates live ~3 days and the chain is pinned to one hardcoded root,
 * so revocation buys almost nothing for real cost.
 */

import { AsnConvert } from '@peculiar/asn1-schema';
import { Certificate, BasicConstraints, KeyUsage, id_ce_basicConstraints, id_ce_keyUsage } from '@peculiar/asn1-x509';

export type ChainFailure =
	| 'bad_x5c_length'
	| 'malformed_certificate'
	| 'cert_not_yet_valid'
	| 'cert_expired'
	| 'unknown_critical_extension'
	| 'leaf_is_ca'
	| 'issuer_not_ca'
	| 'issuer_lacks_key_cert_sign'
	| 'name_chain_broken'
	| 'root_not_self_issued'
	| 'unsupported_signature_algorithm'
	| 'bad_signature'
	| 'unsupported_curve';

export type ChainResult = { ok: true; leafSpki: Uint8Array } | { ok: false; reason: ChainFailure; detail?: string };

/** ECDSA signature algorithm OIDs we accept, mapped to their digest. */
const SIG_ALG_TO_HASH: Record<string, string> = {
	'1.2.840.10045.4.3.2': 'SHA-256',
	'1.2.840.10045.4.3.3': 'SHA-384',
	'1.2.840.10045.4.3.4': 'SHA-512',
};

/** Critical extensions we understand. A critical extension outside this set must be rejected (RFC 5280). */
const KNOWN_CRITICAL_EXTENSIONS = new Set<string>([id_ce_basicConstraints, id_ce_keyUsage, '2.5.29.37']);

const CURVES: Record<string, { name: 'P-256' | 'P-384'; size: number }> = {
	'2a8648ce3d030107': { name: 'P-256', size: 32 },
	'2b81040022': { name: 'P-384', size: 48 },
};

const KEY_CERT_SIGN_BIT = 5;

type Cert = Certificate;

function toHex(b: Uint8Array): string {
	return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
	return diff === 0;
}

function spkiOf(cert: Cert): Uint8Array {
	return new Uint8Array(AsnConvert.serialize(cert.tbsCertificate.subjectPublicKeyInfo));
}

function curveOf(cert: Cert): { name: 'P-256' | 'P-384'; size: number } | null {
	const hex = toHex(spkiOf(cert));
	for (const [oid, curve] of Object.entries(CURVES)) if (hex.includes(oid)) return curve;
	return null;
}

function timeOf(t: { utcTime?: Date; generalTime?: Date }): Date | null {
	return t.utcTime ?? t.generalTime ?? null;
}

function findExtension(cert: Cert, oid: string) {
	return (cert.tbsCertificate.extensions ?? []).find((e) => e.extnID === oid);
}

function basicConstraintsOf(cert: Cert): BasicConstraints | null {
	const ext = findExtension(cert, id_ce_basicConstraints);
	if (!ext) return null;
	return AsnConvert.parse(ext.extnValue.buffer, BasicConstraints);
}

function hasKeyCertSign(cert: Cert): boolean {
	const ext = findExtension(cert, id_ce_keyUsage);
	if (!ext) return false;
	const ku = AsnConvert.parse(ext.extnValue.buffer, KeyUsage);
	// KeyUsage is a BIT STRING; bit 5 is keyCertSign. toNumber() maps bit N to 1<<N.
	return (ku.toNumber() & (1 << KEY_CERT_SIGN_BIT)) !== 0;
}

/** DER SEQUENCE{INTEGER r, INTEGER s} -> raw r||s, `size` bytes each. */
export function derToP1363(der: Uint8Array, size: number): Uint8Array {
	let o = 0;
	if (der[o++] !== 0x30) throw new Error('not a DER sequence');
	o += der[o] & 0x80 ? 1 + (der[o] & 0x7f) : 1;
	const readInt = (): Uint8Array => {
		if (der[o++] !== 0x02) throw new Error('expected INTEGER');
		const len = der[o++];
		let v = der.slice(o, o + len);
		o += len;
		// DER integers are signed: a high bit set means a 0x00 was prepended.
		while (v.length > size && v[0] === 0x00) v = v.slice(1);
		if (v.length > size) throw new Error('integer larger than curve size');
		const padded = new Uint8Array(size);
		padded.set(v, size - v.length);
		return padded;
	};
	const r = readInt();
	const s = readInt();
	const out = new Uint8Array(size * 2);
	out.set(r, 0);
	out.set(s, size);
	return out;
}

/** Verify `child` was signed by `issuer`'s key, using native WebCrypto only. */
async function verifySignedBy(child: Cert, issuer: Cert): Promise<ChainResult | true> {
	// The digest comes from the CHILD's signatureAlgorithm, the curve from the
	// ISSUER's key. Apple's leaf is ecdsa-with-SHA256 signed by a P-384 key, so
	// deriving the hash from the curve (or vice versa) gives a false negative.
	const hash = SIG_ALG_TO_HASH[child.signatureAlgorithm.algorithm];
	if (!hash) return { ok: false, reason: 'unsupported_signature_algorithm', detail: child.signatureAlgorithm.algorithm };

	const curve = curveOf(issuer);
	if (!curve) return { ok: false, reason: 'unsupported_curve' };

	let sig: Uint8Array;
	try {
		sig = derToP1363(new Uint8Array(child.signatureValue), curve.size);
	} catch (e) {
		return { ok: false, reason: 'bad_signature', detail: e instanceof Error ? e.message : String(e) };
	}

	let key: CryptoKey;
	try {
		key = await crypto.subtle.importKey('spki', spkiOf(issuer), { name: 'ECDSA', namedCurve: curve.name }, false, ['verify']);
	} catch {
		return { ok: false, reason: 'unsupported_curve' };
	}

	const tbs = new Uint8Array(AsnConvert.serialize(child.tbsCertificate));
	const ok = await crypto.subtle.verify({ name: 'ECDSA', hash }, key, sig, tbs);
	return ok ? true : { ok: false, reason: 'bad_signature' };
}

function checkValidity(cert: Cert, now: Date): ChainResult | true {
	const notBefore = timeOf(cert.tbsCertificate.validity.notBefore);
	const notAfter = timeOf(cert.tbsCertificate.validity.notAfter);
	if (!notBefore || !notAfter) return { ok: false, reason: 'malformed_certificate', detail: 'validity' };
	if (now < notBefore) return { ok: false, reason: 'cert_not_yet_valid', detail: notBefore.toISOString() };
	if (now > notAfter) return { ok: false, reason: 'cert_expired', detail: notAfter.toISOString() };
	return true;
}

function checkCriticalExtensions(cert: Cert): ChainResult | true {
	for (const ext of cert.tbsCertificate.extensions ?? []) {
		if (ext.critical && !KNOWN_CRITICAL_EXTENSIONS.has(ext.extnID)) {
			return { ok: false, reason: 'unknown_critical_extension', detail: ext.extnID };
		}
	}
	return true;
}

function namesChain(child: Cert, issuer: Cert): boolean {
	const childIssuer = new Uint8Array(AsnConvert.serialize(child.tbsCertificate.issuer));
	const issuerSubject = new Uint8Array(AsnConvert.serialize(issuer.tbsCertificate.subject));
	return bytesEqual(childIssuer, issuerSubject);
}

export interface ChainPolicy {
	/** Injectable clock. Apple's published test vector needs a pinned date - its sample leaf was valid for 3 days in April 2026. */
	now: Date;
	/** Pinned Apple App Attest root, DER. Never taken from the client's x5c. */
	rootDer: Uint8Array;
}

/**
 * Validate an App Attest x5c chain: [leaf, intermediate], anchored to the
 * pinned root. Returns the leaf SPKI on success so the caller can derive the
 * key id and later verify assertions.
 */
export async function verifyChain(x5c: Uint8Array[], policy: ChainPolicy): Promise<ChainResult> {
	if (!Array.isArray(x5c) || x5c.length !== 2) {
		return { ok: false, reason: 'bad_x5c_length', detail: String(x5c?.length) };
	}

	let leaf: Cert, intermediate: Cert, root: Cert;
	try {
		leaf = AsnConvert.parse(x5c[0], Certificate);
		intermediate = AsnConvert.parse(x5c[1], Certificate);
		root = AsnConvert.parse(policy.rootDer, Certificate);
	} catch (e) {
		return { ok: false, reason: 'malformed_certificate', detail: e instanceof Error ? e.message : String(e) };
	}

	for (const cert of [leaf, intermediate, root]) {
		const v = checkValidity(cert, policy.now);
		if (v !== true) return v;
		const c = checkCriticalExtensions(cert);
		if (c !== true) return c;
	}

	// The leaf must not be a CA; both issuers must be CAs that may sign certs.
	if (basicConstraintsOf(leaf)?.cA === true) return { ok: false, reason: 'leaf_is_ca' };
	for (const [cert, label] of [
		[intermediate, 'intermediate'],
		[root, 'root'],
	] as const) {
		if (basicConstraintsOf(cert)?.cA !== true) return { ok: false, reason: 'issuer_not_ca', detail: label };
		if (!hasKeyCertSign(cert)) return { ok: false, reason: 'issuer_lacks_key_cert_sign', detail: label };
	}

	// Anchor sanity first, so a non-self-issued "root" reports that rather than
	// surfacing as a generic broken name chain.
	if (!namesChain(root, root)) return { ok: false, reason: 'root_not_self_issued' };
	if (!namesChain(leaf, intermediate)) return { ok: false, reason: 'name_chain_broken', detail: 'leaf->intermediate' };
	if (!namesChain(intermediate, root)) return { ok: false, reason: 'name_chain_broken', detail: 'intermediate->root' };

	const leafSig = await verifySignedBy(leaf, intermediate);
	if (leafSig !== true) return leafSig;
	const interSig = await verifySignedBy(intermediate, root);
	if (interSig !== true) return interSig;

	return { ok: true, leafSpki: spkiOf(leaf) };
}
