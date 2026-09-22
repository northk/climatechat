/**
 * SPIKE — negative tests for the hand-rolled chain validator (src/spikeChain.ts).
 *
 * Every policy check gets a test that makes it FIRE, asserting the specific
 * rejection reason. A test that only asserts "rejected" can pass for the wrong
 * reason, which is exactly how a hand-rolled validator ends up with a check
 * that silently never runs.
 *
 * Most negative cases are built by reusing Apple's real certificates in wrong
 * positions; the rest by mutating DER via an AsnConvert round-trip.
 */

import { describe, it, expect } from 'vitest';
import { AsnConvert, OctetString } from '@peculiar/asn1-schema';
import { Certificate, Extension, KeyUsage } from '@peculiar/asn1-x509';
import vector from './fixtures/apple_appattest_vector.json';
import { verifyChain, derToP1363, type ChainFailure } from '../src/spikeChain';

function b64(s: string): Uint8Array {
	const bin = atob(s);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}
function toB64(b: Uint8Array): string {
	let s = '';
	for (const byte of b) s += String.fromCharCode(byte);
	return btoa(s);
}

const LEAF = b64(vector.expectedLeafCert);
const INTERMEDIATE = b64(vector.expectedIntermediateCert);
const ROOT = b64(vector.appleRootCertDer);

/**
 * Apple's sample leaf was valid 2026-04-20 -> 2026-04-23 (a 3-day cert that
 * has long since expired). The vector is only usable with a pinned clock.
 */
const WITHIN_VALIDITY = new Date('2026-04-21T00:00:00Z');
const policy = (now: Date = WITHIN_VALIDITY, rootDer: Uint8Array = ROOT) => ({ now, rootDer });

/** Parse -> mutate -> re-serialize a certificate. */
function mutate(der: Uint8Array, fn: (cert: Certificate) => void): Uint8Array {
	const cert = AsnConvert.parse(der, Certificate);
	fn(cert);
	return new Uint8Array(AsnConvert.serialize(cert));
}

async function expectReason(x5c: Uint8Array[], reason: ChainFailure, p = policy()) {
	const result = await verifyChain(x5c, p);
	if (result.ok) throw new Error(`expected rejection "${reason}" but chain was accepted`);
	expect(result.reason).toBe(reason);
	return result;
}

describe('chain validator - positive path', () => {
	it('accepts Apple’s real chain within the validity window and returns the leaf SPKI', async () => {
		const result = await verifyChain([LEAF, INTERMEDIATE], policy());
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		// the returned SPKI must derive Apple's published keyId
		const key = await crypto.subtle.importKey('spki', result.leafSpki, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
		const point = new Uint8Array((await crypto.subtle.exportKey('raw', key)) as ArrayBuffer);
		const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', point));
		expect(toB64(digest)).toBe(vector.keyId);
	});
});

describe('chain validator - validity window', () => {
	it('rejects an expired leaf (today, against Apple’s 3-day sample cert)', async () => {
		const r = await expectReason([LEAF, INTERMEDIATE], 'cert_expired', policy(new Date('2026-09-21T00:00:00Z')));
		console.log('[chain] expired detail = ' + r.detail);
	});

	it('rejects a not-yet-valid leaf', async () => {
		await expectReason([LEAF, INTERMEDIATE], 'cert_not_yet_valid', policy(new Date('2026-01-01T00:00:00Z')));
	});

	it('rejects one second past notAfter (boundary)', async () => {
		await expectReason([LEAF, INTERMEDIATE], 'cert_expired', policy(new Date('2026-04-23T18:13:13Z')));
	});

	it('accepts one second before notAfter (boundary)', async () => {
		const r = await verifyChain([LEAF, INTERMEDIATE], policy(new Date('2026-04-23T18:13:11Z')));
		expect(r.ok).toBe(true);
	});
});

describe('chain validator - structural policy', () => {
	it('rejects an x5c that is not exactly [leaf, intermediate]', async () => {
		await expectReason([LEAF], 'bad_x5c_length');
		await expectReason([LEAF, INTERMEDIATE, ROOT], 'bad_x5c_length');
	});

	it('rejects a CA certificate presented as the leaf', async () => {
		// the intermediate has CA:TRUE, so using it in the leaf slot must fail
		await expectReason([INTERMEDIATE, ROOT], 'leaf_is_ca');
	});

	it('rejects a non-CA certificate presented as the issuer', async () => {
		await expectReason([LEAF, LEAF], 'issuer_not_ca');
	});

	it('rejects an issuer whose keyUsage lacks keyCertSign', async () => {
		// strip keyCertSign from the intermediate, leaving digitalSignature only
		const noCertSign = mutate(INTERMEDIATE, (cert) => {
			const ext = cert.tbsCertificate.extensions!.find((e) => e.extnID === '2.5.29.15')!;
			ext.extnValue = new OctetString(AsnConvert.serialize(new KeyUsage(0x01)));
		});
		await expectReason([LEAF, noCertSign], 'issuer_lacks_key_cert_sign');
	});

	it('rejects a broken issuer/subject name chain', async () => {
		// root in the intermediate slot: leaf.issuer no longer matches
		await expectReason([LEAF, ROOT], 'name_chain_broken');
	});

	it('rejects a non-self-issued trust anchor', async () => {
		await expectReason([LEAF, INTERMEDIATE], 'root_not_self_issued', policy(WITHIN_VALIDITY, INTERMEDIATE));
	});
});

describe('chain validator - extension handling', () => {
	it('rejects an unrecognised CRITICAL extension', async () => {
		const withCritical = mutate(LEAF, (cert) => {
			cert.tbsCertificate.extensions!.push(
				new Extension({ extnID: '1.3.6.1.4.1.99999.1', critical: true, extnValue: new OctetString(new Uint8Array([0x05, 0x00])) }),
			);
		});
		await expectReason([withCritical, INTERMEDIATE], 'unknown_critical_extension');
	});

	it('TOLERATES an unrecognised NON-critical extension', async () => {
		// Apple's own 8.2/8.5/8.6/8.7 extensions are non-critical, so the strict
		// critical-extension rule must not trip on unknown non-critical ones.
		const withNonCritical = mutate(LEAF, (cert) => {
			cert.tbsCertificate.extensions!.push(
				new Extension({ extnID: '1.3.6.1.4.1.99999.2', critical: false, extnValue: new OctetString(new Uint8Array([0x05, 0x00])) }),
			);
		});
		// mutating the TBS invalidates the signature, so this must fail LATER,
		// at signature verification - not at the extension check.
		await expectReason([withNonCritical, INTERMEDIATE], 'bad_signature');
	});
});

describe('chain validator - signature policy', () => {
	it('rejects a tampered signature', async () => {
		const tampered = mutate(LEAF, (cert) => {
			const sig = new Uint8Array(cert.signatureValue);
			sig[sig.length - 1] ^= 0xff;
			cert.signatureValue = sig.buffer;
		});
		await expectReason([tampered, INTERMEDIATE], 'bad_signature');
	});

	it('rejects a signature algorithm outside the allowlist', async () => {
		const rsaAlg = mutate(LEAF, (cert) => {
			cert.signatureAlgorithm.algorithm = '1.2.840.113549.1.1.11'; // sha256WithRSAEncryption
		});
		await expectReason([rsaAlg, INTERMEDIATE], 'unsupported_signature_algorithm');
	});

	it('rejects an issuer key on an unsupported curve', async () => {
		// corrupt the curve OID in the intermediate's SPKI parameters
		const badCurve = mutate(INTERMEDIATE, (cert) => {
			cert.tbsCertificate.subjectPublicKeyInfo.algorithm.parameters = new Uint8Array([0x06, 0x03, 0x2a, 0x03, 0x04]).buffer;
		});
		await expectReason([LEAF, badCurve], 'unsupported_curve');
	});
});

describe('derToP1363', () => {
	it('strips the DER sign byte and left-pads short components', () => {
		// r has the high bit set (gets a 0x00 prefix in DER), s is short
		const r = new Uint8Array(33);
		r[0] = 0x00;
		r[1] = 0xff;
		r.fill(0x11, 2);
		const s = new Uint8Array(30).fill(0x22);
		const der = new Uint8Array([0x30, 2 + r.length + 2 + s.length, 0x02, r.length, ...r, 0x02, s.length, ...s]);

		const out = derToP1363(der, 32);
		expect(out.length).toBe(64);
		expect(out[0]).toBe(0xff); // leading 0x00 stripped
		expect(out[32]).toBe(0x00); // s left-padded by two bytes
		expect(out[33]).toBe(0x00);
		expect(out[34]).toBe(0x22);
	});

	it('produces 48-byte components for P-384', () => {
		const r = new Uint8Array(48).fill(0xab);
		const s = new Uint8Array(48).fill(0xcd);
		const der = new Uint8Array([0x30, 0x64, 0x02, 48, ...r, 0x02, 48, ...s]);
		expect(derToP1363(der, 48).length).toBe(96);
	});

	it('throws on an integer larger than the curve size', () => {
		const r = new Uint8Array(40).fill(0x11);
		const der = new Uint8Array([0x30, 44, 0x02, 40, ...r, 0x02, 0x01, 0x01]);
		expect(() => derToP1363(der, 32)).toThrow();
	});
});
