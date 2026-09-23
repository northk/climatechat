/**
 * SPIKE (not production code) — app-attest-design.md §8 questions 1 and 4,
 * plus the Apple-vector replay. X.509 strategy lives in spike-x509.spec.ts.
 *
 * Runs against Apple's Attestation Object Validation Guide vector
 * (test/fixtures/apple_appattest_vector.json) — no device required.
 */

import { describe, it, expect } from 'vitest';
import vector from './fixtures/apple_appattest_vector.json';

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
function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
	const out = new Uint8Array(a.length + b.length);
	out.set(a, 0);
	out.set(b, a.length);
	return out;
}
async function sha256(d: Uint8Array): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest('SHA-256', d));
}

interface AuthData {
	rpIdHash: Uint8Array;
	flags: number;
	counter: number;
	aaguid: Uint8Array;
	credentialId: Uint8Array;
	encodedKey: Uint8Array;
	extensions: Uint8Array;
}

function parseAuthData(a: Uint8Array): AuthData {
	const dv = new DataView(a.buffer, a.byteOffset, a.byteLength);
	let o = 0;
	const rpIdHash = a.slice(o, (o += 32));
	const flags = a[o++];
	const counter = dv.getUint32(o, false);
	o += 4;
	const aaguid = a.slice(o, (o += 16));
	const credIdLen = dv.getUint16(o, false);
	o += 2;
	const credentialId = a.slice(o, (o += credIdLen));
	const encodedKey = a.slice(o, (o += 77));
	const extensions = a.slice(o);
	return { rpIdHash, flags, counter, aaguid, credentialId, encodedKey, extensions };
}

describe('SPIKE 1 - CBOR libraries under workerd', () => {
	it('cbor-x imports and decodes the attestation object (zero runtime deps)', async () => {
		const { decode } = await import('cbor-x');
		const obj = decode(b64(vector.attestationObject)) as Record<string, unknown>;
		expect(obj.fmt).toBe('apple-appattest');
		const att = obj.attStmt as { x5c: Uint8Array[]; receipt: Uint8Array };
		expect(att.x5c.length).toBe(2);
		expect(obj.authData).toBeInstanceOf(Uint8Array);
		console.log('[cbor-x] OK  x5c=' + att.x5c.length + ' authData=' + (obj.authData as Uint8Array).length + 'B');
	});

	// cbor2 was measured here and also worked under workerd, but was REJECTED:
	// it carries a runtime dependency where cbor-x has none. Finding recorded in
	// app-attest-design.md §12 Q1; the test was removed along with the package so
	// main does not carry dependencies we have decided against.
});

describe('SPIKE 2 - Apple vector replay', () => {
	/**
	 * FINDING: Apple's step-2 prose says clientDataHash is "the SHA256 hash of
	 * the one-time challenge". Their published vector does NOT follow that —
	 * the composite ends with the RAW challenge bytes, and the nonce sealed in
	 * the credCert (ground truth, produced by the Secure Enclave) only matches
	 * the raw-challenge form. clientDataHash is really "whatever bytes the app
	 * passed to attestKey()"; client and server must simply agree.
	 */
	it('nonce reproduces only with the RAW challenge, not SHA256(challenge)', async () => {
		const { decode } = await import('cbor-x');
		const { authData } = decode(b64(vector.attestationObject)) as { authData: Uint8Array };
		const raw = new TextEncoder().encode(vector.serverChallenge);

		const composite = concat(authData, raw);
		expect(toB64(composite)).toBe(vector.expectedAuthDataPlusClientDataHash);

		const nonceRaw = toB64(await sha256(composite));
		const nonceHashed = toB64(await sha256(concat(authData, await sha256(raw))));
		console.log('[conv] credCert nonce                       = ' + vector.expectedNonce);
		console.log('[conv] SHA256(authData || rawChallenge)      = ' + nonceRaw);
		console.log('[conv] SHA256(authData || SHA256(challenge)) = ' + nonceHashed);
		expect(nonceRaw).toBe(vector.expectedNonce);
		expect(nonceHashed).not.toBe(vector.expectedNonce);
	});

	it('authenticator data invariants match Apple expected values', async () => {
		const { decode } = await import('cbor-x');
		const { authData } = decode(b64(vector.attestationObject)) as { authData: Uint8Array };
		const ad = parseAuthData(authData);
		const appIdHash = await sha256(new TextEncoder().encode(vector.appId));
		console.log('[authdata] counter=' + ad.counter + ' aaguid="' + new TextDecoder().decode(ad.aaguid).replace(/\0/g, '.') + '"');
		expect(toB64(ad.rpIdHash)).toBe(vector.expectedRpIdHash);
		expect(toB64(appIdHash)).toBe(vector.expectedAppIdHash);
		expect(ad.counter).toBe(0);
		expect(toB64(ad.credentialId)).toBe(vector.expectedCredentialId);
		expect(toB64(ad.credentialId)).toBe(vector.keyId);
		// production aaguid = "appattest" + seven 0x00
		expect(new TextDecoder().decode(ad.aaguid.slice(0, 9))).toBe('appattest');
		expect([...ad.aaguid.slice(9)].every((b) => b === 0)).toBe(true);
	});

	/**
	 * FINDING: apple_validation_category_01 is a 4-byte LITTLE-ENDIAN UInt32 in
	 * a CBOR byte string, not a CBOR integer. Reading it as big-endian or as a
	 * CBOR int gives the wrong category and would let the wrong build classes in.
	 */
	it('extensions CBOR carries validation category (LE uint32) and bundle version', async () => {
		const { decode } = await import('cbor-x');
		const { authData } = decode(b64(vector.attestationObject)) as { authData: Uint8Array };
		const ad = parseAuthData(authData);
		const ext = decode(ad.extensions) as Record<string, unknown>;
		console.log('[ext] keys = ' + JSON.stringify(Object.keys(ext)));

		const catRaw = ext['apple_validation_category_01'] as Uint8Array;
		expect(catRaw).toBeInstanceOf(Uint8Array);
		expect(catRaw.length).toBe(4);
		const le = new DataView(catRaw.buffer, catRaw.byteOffset, 4).getUint32(0, true);
		const be = new DataView(catRaw.buffer, catRaw.byteOffset, 4).getUint32(0, false);
		console.log(`[ext] validation_category bytes=${toB64(catRaw)} LE=${le} BE=${be} (Apple expects ${vector.expectedValidationCategory})`);
		console.log('[ext] bundle_version = ' + JSON.stringify(ext['apple_bundle_version_01']));
		expect(le).toBe(vector.expectedValidationCategory);
		expect(be).not.toBe(vector.expectedValidationCategory);
	});
});
