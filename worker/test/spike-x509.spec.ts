/**
 * SPIKE (not production code) — X.509 strategy for App Attest under workerd.
 * Tests three routes: @peculiar/x509 with a reflect-metadata polyfill,
 * @peculiar/asn1-x509 used directly (no DI container), and native WebCrypto
 * for the chain signature check.
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

async function x5c(): Promise<Uint8Array[]> {
	const { decode } = await import('cbor-x');
	const obj = decode(b64(vector.attestationObject)) as { attStmt: { x5c: Uint8Array[] } };
	return obj.attStmt.x5c;
}

/**
 * ROUTE A (@peculiar/x509 + a reflect-metadata polyfill) was measured here and
 * REJECTED — the package pulls `tsyringe`, a DI container that throws
 * "requires a reflect polyfill" on import under workerd. It works with the
 * polyfill, but that is two extra dependencies (one a DI framework) on a
 * security path, for no capability Route B lacks. Finding recorded in
 * app-attest-design.md §12 Q2; the test was removed along with the packages so
 * main does not carry dependencies we have decided against.
 */
describe('ROUTE B - @peculiar/asn1-x509 directly, no DI container', () => {
	it('parses the certificate and finds the App Attest nonce extension', async () => {
		const { AsnConvert } = await import('@peculiar/asn1-schema');
		const { Certificate } = await import('@peculiar/asn1-x509');
		const certs = await x5c();
		const cert = AsnConvert.parse(certs[0], Certificate);
		const exts = cert.tbsCertificate.extensions ?? [];
		console.log('[B] extension OIDs: ' + exts.map((e) => e.extnID).join(', '));
		const nonceExt = exts.find((e) => e.extnID === '1.2.840.113635.100.8.2');
		expect(nonceExt).toBeTruthy();
		const raw = new Uint8Array(nonceExt!.extnValue.buffer);
		let found: Uint8Array | null = null;
		for (let i = 0; i + 34 <= raw.length; i++) {
			if (raw[i] === 0x04 && raw[i + 1] === 0x20) {
				found = raw.slice(i + 2, i + 34);
				break;
			}
		}
		console.log('[B] nonce from cert: ' + toB64(found!));
		expect(toB64(found!)).toBe(vector.expectedCredCertOctetString);
	});

	it('extracts the SPKI and derives the key id via native WebCrypto', async () => {
		const { AsnConvert } = await import('@peculiar/asn1-schema');
		const { Certificate } = await import('@peculiar/asn1-x509');
		const certs = await x5c();
		const cert = AsnConvert.parse(certs[0], Certificate);
		const spki = new Uint8Array(AsnConvert.serialize(cert.tbsCertificate.subjectPublicKeyInfo));
		const key = await crypto.subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
		const point = new Uint8Array((await crypto.subtle.exportKey('raw', key)) as ArrayBuffer);
		const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', point));
		console.log('[B] point[0]=0x' + point[0].toString(16) + ' len=' + point.length);
		console.log('[B] SHA256(X9.62 point) = ' + toB64(digest));
		console.log('[B] fixture keyId       = ' + vector.keyId);
		console.log('[B] Apple stated value  = ' + vector.expectedPublicKeySha256);
		console.log('[B] == keyId ? ' + (toB64(digest) === vector.keyId));
		console.log('[B] == Apple stated ? ' + (toB64(digest) === vector.expectedPublicKeySha256));
		expect(point[0]).toBe(0x04);
		expect(point.length).toBe(65);
		expect(toB64(digest)).toBe(vector.keyId);
	});

	it('verifies the FULL chain leaf -> intermediate -> Apple root with native WebCrypto only', async () => {
		const { AsnConvert } = await import('@peculiar/asn1-schema');
		const { Certificate } = await import('@peculiar/asn1-x509');
		const certs = await x5c();
		const leaf = AsnConvert.parse(certs[0], Certificate);
		const inter = AsnConvert.parse(certs[1], Certificate);
		const root = AsnConvert.parse(b64(vector.appleRootCertDer), Certificate);

		// NOTE: component size is curve-dependent. Apple's leaf is P-256 (32-byte
		// r/s) but the intermediate and root are P-384 (48-byte r/s). A hardcoded
		// 32 silently breaks chain verification.
		function derToP1363(der: Uint8Array, size: number): Uint8Array {
			let o = 0;
			if (der[o++] !== 0x30) throw new Error('not a DER sequence');
			o += der[o] & 0x80 ? 1 + (der[o] & 0x7f) : 1;
			const readInt = (): Uint8Array => {
				if (der[o++] !== 0x02) throw new Error('expected INTEGER');
				const len = der[o++];
				let v = der.slice(o, o + len);
				o += len;
				while (v.length > size && v[0] === 0x00) v = v.slice(1);
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

		// curve of the *issuer* key decides component size and import params
		function curveOf(cert: typeof leaf): { name: 'P-256' | 'P-384'; size: number } {
			const spki = new Uint8Array(AsnConvert.serialize(cert.tbsCertificate.subjectPublicKeyInfo));
			const hex = [...spki].map((b) => b.toString(16).padStart(2, '0')).join('');
			if (hex.includes('2b81040022')) return { name: 'P-384', size: 48 };
			if (hex.includes('2a8648ce3d030107')) return { name: 'P-256', size: 32 };
			throw new Error('unrecognised curve');
		}

		// The digest comes from the CHILD's signatureAlgorithm OID — not from the
		// issuer's curve. Apple's leaf is ecdsa-with-SHA256 signed by a P-384 key,
		// so guessing the hash from the curve gives a false negative.
		const HASH_BY_OID: Record<string, string> = {
			'1.2.840.10045.4.3.2': 'SHA-256',
			'1.2.840.10045.4.3.3': 'SHA-384',
			'1.2.840.10045.4.3.4': 'SHA-512',
		};

		async function verifyUnder(child: typeof leaf, issuer: typeof leaf, label: string): Promise<boolean> {
			const { name, size } = curveOf(issuer);
			const spki = new Uint8Array(AsnConvert.serialize(issuer.tbsCertificate.subjectPublicKeyInfo));
			const key = await crypto.subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: name }, false, ['verify']);
			const tbs = new Uint8Array(AsnConvert.serialize(child.tbsCertificate));
			const sig = derToP1363(new Uint8Array(child.signatureValue), size);
			const sigOid = child.signatureAlgorithm.algorithm;
			const hash = HASH_BY_OID[sigOid];
			if (!hash) throw new Error('unsupported signature algorithm ' + sigOid);
			const ok = await crypto.subtle.verify({ name: 'ECDSA', hash }, key, sig, tbs);
			console.log(`[B] ${label}: issuerKey=${name} sigAlg=${sigOid} (${hash}) -> ${ok}`);
			return ok;
		}

		console.log('[B] leaf curve = ' + curveOf(leaf).name + ', intermediate curve = ' + curveOf(inter).name);
		expect(await verifyUnder(leaf, inter, 'leaf under intermediate')).toBe(true);
		expect(await verifyUnder(inter, root, 'intermediate under Apple root')).toBe(true);
		// trust anchor must actually be Apple's pinned root
		expect(root.tbsCertificate.issuer).toEqual(root.tbsCertificate.subject);
	});
});

describe('SPIKE - clientDataHash convention in Apple’s own vector', () => {
	it('shows the published vector used the RAW challenge, not its SHA256', async () => {
		const { decode } = await import('cbor-x');
		const obj = decode(b64(vector.attestationObject)) as { authData: Uint8Array };
		const enc = new TextEncoder();
		const sha = async (d: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', d));
		const cat = (a: Uint8Array, b: Uint8Array) => {
			const o = new Uint8Array(a.length + b.length);
			o.set(a);
			o.set(b, a.length);
			return o;
		};
		const raw = enc.encode(vector.serverChallenge);
		const hashed = await sha(raw);
		const nonceFromRaw = toB64(await sha(cat(obj.authData, raw)));
		const nonceFromHashed = toB64(await sha(cat(obj.authData, hashed)));
		console.log('[conv] credCert nonce                       = ' + vector.expectedNonce);
		console.log('[conv] SHA256(authData || rawChallenge)      = ' + nonceFromRaw);
		console.log('[conv] SHA256(authData || SHA256(challenge)) = ' + nonceFromHashed);
		expect(nonceFromRaw).toBe(vector.expectedNonce);
		expect(nonceFromHashed).not.toBe(vector.expectedNonce);
	});
});
