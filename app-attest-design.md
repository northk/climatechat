# App Attest — Implementation Design and Verdict

> Status: **design agreed, not yet implemented.** Written 2026-09-21 after comparing two
> independent proposals (Claude's and ChatGPT Codex's) for verifying Apple App Attest
> inside the Cloudflare Worker.
>
> **Verified against Apple's official documentation on 2026-09-21** (`Validating apps that
> connect to your server` + `Attestation Object Validation Guide`). Changes that review
> produced are marked inline; the biggest are §5 step 7 (extensions / validation
> category), §6a (challenges reinstated), §10 (Apple publishes a full attestation test
> vector) and §11 (fixture blocker much smaller than first assessed).
>
> Context: this work was triggered by finding #3 of the Codex review of `worker/src` —
> the Worker currently accepts arbitrary client-supplied `role: "assistant"` history and
> feeds it straight to Claude with no provenance check (see "Why we're doing this" below).
> Related: `project-plan.md` R10, Phase 3 step 22, Phase 4 step 27.

---

## 1. Why we're doing this

`claude.ts` sends whatever `messages` array the client submits into the Claude
conversation, including any `role: "assistant"` entries. Nothing establishes that those
turns were ever actually produced by this Worker. A caller holding the app secret can
fabricate prior assistant turns to manufacture fake "the assistant already agreed to
this" precedent — a materially stronger jailbreak vector than a single adversarial user
message — or to fake tool-sourced citations. That undermines Section 7 rule 1 (numbers
only from tool calls) and rule 7 (scope enforcement).

The `X-App-Secret` header cannot fix this. R10 already documents that it is friction, not
access control: it ships inside the compiled app and is extractable. More fundamentally,
a shared secret says nothing about whether the *body* of a request is legitimate.

Two alternatives were considered and rejected:

- **Chained HMAC over the transcript.** Workable, stateless, cheap. Rejected because it
  only proves "this Worker emitted this text at some point." Signing each turn
  independently permits a collage attack — reassembling genuinely-signed replies into a
  new, misleading transcript — so it must chain-hash the entire ordered transcript to be
  sound, and at that point it is a bespoke security protocol we'd be inventing and
  maintaining ourselves.
- **Server-side conversation store keyed by an opaque ID.** Reverses the stateless
  thin-backend design (plan Section 2) and burns a KV write per turn against the R4
  budget, which is already this app's binding cost constraint.

App Attest was chosen because it establishes real hardware-backed provenance and also
subsumes R10's original freeloading/scraping concern, rather than solving only this one
finding.

### 1a. What App Attest does *not* prove — accepted residual risk

Be precise about the provenance App Attest gives us: it proves a request was **sent by a
genuine, unmodified instance of the app on real Apple hardware**. It does **not** prove
the `role: "assistant"` turns in that request were **authored by this Worker**. The
finding is closed only in the sense that the sole remaining sender is our own app, which
only ever replays what the Worker returned to it.

The gap is a **jailbroken device**. There, an attacker can hook the genuine, attested app
at runtime (e.g. Frida) and rewrite the history *before* it is signed; the assertion then
verifies perfectly. Apple states App Attest cannot definitively detect a compromised OS,
and no app-side or server-side measure practically can — once the device's OS is owned,
the device is the attacker's. We therefore **accept this risk rather than mitigate it**,
because its blast radius is small and already bounded elsewhere:

- **Self-only impact.** Multi-turn requests are never cached (`cache.ts`, R9), so a forged
  transcript can only mislead the attacker's own session, never another user's answer.
- **No forged tool data.** History entries must be plain strings (`parseMessages`), so a
  forged turn can *claim* a figure but cannot inject a `tool_result`; chart data points
  are only ever injected from tool calls made within the current request.
- **Bounded cost.** A jailbroken device still needs its own attested key, so it is
  subject to the per-keyId rate limit, plus the input-size limits (`MAX_MESSAGES`,
  `MAX_MESSAGE_LENGTH`, `MAX_BODY_LENGTH`) and the Anthropic spend cap (plan 8.1).

**Do not treat this as an open item** or re-introduce transcript signing / a server-side
conversation store to close it: both were rejected above, and neither would stop a
jailbroken device either — the genuine app would faithfully sign or reference whatever
the hooked process hands it.

---

## 2. Decision: the stack

| Layer | Choice | Notes |
|---|---|---|
| SHA-256, ECDSA P-256 verify, key import | **Native `crypto.subtle`** | BoringSSL under workerd. No dependency. |
| DER → IEEE-P1363 signature conversion | **Our own ~20-line helper** | Required because Apple emits DER, WebCrypto wants raw `r‖s`. |
| CBOR decode | **`cbor-x`** | **Zero runtime dependencies.** Verified decoding Apple's vector under workerd (§12). |
| X.509 parsing | **`@peculiar/asn1-schema` + `@peculiar/asn1-x509`** | Enrollment path only. Plain ASN.1 codecs, no DI container. Pin exact versions. |
| Certificate chain validation | **Hand-rolled over native `crypto.subtle`** | Verified working end-to-end against Apple's real chain (§12). No chain library needed. |
| Challenge + counter state | **SQLite-backed Durable Object**, keyed by App Attest key ID | Free-tier available; storage billing waived on free plan. **Transaction pattern matters — see §7 pitfall 6.** |
| Apple App Attest root CA | **Bundled as a constant** in the Worker | Source: <https://www.apple.com/certificateauthority/private>. Never fetched at runtime, never taken from the client's `x5c`. |

**Rejected:** `@noble/curves`, `pkijs`, `node-app-attest`, `appattest-checker-node`, `cbor2`
(works, but has a dependency where `cbor-x` has none), and **`@peculiar/x509`** — it pulls
`tsyringe`, a DI container that throws `requires a reflect polyfill` under workerd unless
`reflect-metadata` is imported first. It does work with that polyfill, but the lower-level
`@peculiar/asn1-*` packages do the same job with no DI and no polyfill (§12).

---

## 3. Verdict on the two proposals

Codex's proposal was better on the two highest-stakes decisions, and its base is what
we're adopting.

**Native WebCrypto beats `@noble/curves` (Claude's original pick was wrong).** The
original argument for noble was that it verifies DER signatures directly, sparing us a
format conversion. That optimizes convenience over dependency count — backwards for this
project's stated criteria. The conversion is ~20 lines. Trading that for an entire
pure-JS elliptic-curve implementation is a bad deal when workerd ships audited,
constant-time, natively-implemented ECDSA that is by definition "known to work in the
Cloudflare environment."

**Durable Objects for state (Claude missed this entirely).** The original proposal never
specified where attestation state lives, and the path of least resistance would have been
`CLIMATE_KV`. That is a genuine security bug: KV is eventually consistent, so two
concurrent requests can both read the same counter, both judge it fresh, and both pass —
silently defeating the replay protection that is the counter's entire purpose. Note the
precedent: `rateLimit.ts` already carries a documented non-atomic race, accepted because
its worst case is a user getting a 6th question. Here the worst case is a successful
replay. Not acceptable.

**Key-ID derivation (Codex catch).** Apple's key ID is `SHA-256` of the raw 65-byte
uncompressed X9.62 point (`0x04 ‖ X ‖ Y`), **not** of the SPKI structure. Getting this
wrong produces a verifier that rejects every legitimate device.

**What survived from the original proposal:** the hot-path/enrollment-path split. Both
analyses arrived at it independently, and it is the structural decision that keeps
per-request cost low.

**Where Codex's design is being changed:**

- *Its sample assertion code appears to double-hash.* See §7, pitfall 1.
- *Per-request server challenges — Codex was right, my objection was withdrawn.* I first
  proposed dropping them to save a round-trip; Apple's documented assertion step 6
  requires a challenge in `clientData`. Kept, with the round-trip cost engineered away by
  piggybacking the next challenge on each response (§6a).
- *"Small libraries" undercounts, and the spike made it worse then better.*
  `@peculiar/x509` alone pulls 11 direct dependencies including a DI container that
  **doesn't run under workerd without a polyfill** (§12). Dropping it for the lower-level
  `@peculiar/asn1-*` packages removes that problem entirely.

---

## 4. Architecture: two paths of very different weight

```
Enrollment (once per app install)        Assertion (every /ask request)
─────────────────────────────────        ──────────────────────────────
POST /attest/challenge → challenge       headers: keyId + assertion
POST /attest/register  → verify:         body-size check FIRST, then verify:
  • CBOR decode attestation                • CBOR decode assertion
  • X.509 chain → pinned Apple root        • parse authenticatorData
  • nonce extension check                  • rpIdHash check
  • keyId == SHA256(X9.62 point)           • challenge match (§6a)
  • authenticatorData invariants           • counter strictly increasing
  • extensions: category + version         • extensions: category + version
  • store SPKI + counter=0                 • ECDSA verify (native)
                                         → accept-and-advance counter inside
                                           blockConcurrencyWhile()  (§7 pitfall 6)
CBOR + X.509 + ASN.1 + native crypto     CBOR + native crypto only
                                         + next challenge piggybacked on response
```

The expensive, dependency-heavy work happens once per device. The per-request path needs
no certificate handling at all — it verifies against a public key already stored at
enrollment.

---

## 5. Enrollment path (Apple's server-side validation procedure)

Given `{ keyId, attestation }`:

1. Route to the device DO for `keyId` and consume its pending enrollment challenge
   (single-use, alarm-expiring) inside `blockConcurrencyWhile()`. Reject if there is no
   pending challenge, or it has already been consumed.

   No separate `challengeId` is needed. Since challenges now live in the device's own DO
   (§5a) rather than a shared KV namespace, the DO holds at most one pending challenge
   for its key and looks it up itself — one fewer client-supplied field to validate.
2. CBOR-decode the attestation object. Require `fmt === "apple-appattest"` and
   `attStmt.x5c.length >= 2`.
3. Validate the certificate chain: leaf signed by intermediate, intermediate chaining to
   the **bundled** Apple App Attest root. Check validity windows, issuer/subject
   relationships, and basic constraints. Explicitly assert the resulting chain terminates
   at our pinned root — "a chain was built" is not sufficient. Note the **leaf** key is
   EC P-256 but the **issuers are P-384** (pitfall 7); the validator accepts both and
   derives component size per certificate. Implemented and tested — see §12 Q3.
4. Compute `clientDataHash` (see the **convention decision** below) and
   `nonce = SHA256(authenticatorData ‖ clientDataHash)`. Extract the leaf's extension
   `1.2.840.113635.100.8.2` (DER, containing a nested OCTET STRING) and compare to
   `nonce` with `crypto.subtle.timingSafeEqual`.

   > **DECISION — `clientDataHash` convention.** Apple does not enforce one: the value is
   > simply whatever bytes the app passed to `attestKey()`, and the server must use the
   > identical bytes (§12 Bonus 1). **We choose `clientDataHash = SHA256(challenge)`**,
   > matching Apple's documented prose. This is a two-sided contract — the Phase 4 iOS
   > client MUST hash the challenge before calling `attestKey`/`generateAssertion`, and a
   > mismatch here fails closed with no useful error. Note the consequence for testing:
   > **Apple's published vector used the raw challenge**, so the fixture test must feed
   > raw bytes while production feeds a hash. Do not "fix" that discrepancy in the test.
5. Extract the leaf's public key as the uncompressed X9.62 point and assert
   `SHA256(0x04 ‖ X ‖ Y) === base64decode(keyId)`.
6. Parse `authenticatorData` strictly (all offsets bounds-checked):
   `rpIdHash(32) ‖ flags(1) ‖ counter(4 BE) ‖ aaguid(16) ‖ credIdLen(2 BE) ‖ credId(32) ‖ encodedKey(77, COSE) ‖ extensions(variable, CBOR)`.
   Require `rpIdHash === SHA256(APP_ID)`, `counter === 0`, `credentialId === keyId`, and
   `aaguid` equal to `appattestdevelop` (development) or `appattest` followed by seven
   `0x00` bytes (production) — **both values confirmed verbatim against Apple's docs
   2026-09-21.**
7. Verify the **`extensions` CBOR dictionary** in the authenticator data:
   - `apple_validation_category_01` (`UInt32`) — the launch validation category of the
     binary. Apple's table: `1` OS executable, `2` **TestFlight**, `3` development-signed,
     `4` **App Store**, `5` Enterprise/ad-hoc, `6` Developer ID, `7–9` restricted
     system-generated, `10` other signing identity.
   - `apple_bundle_version_01` (`String`) — the distributed app's bundle version.

   > **DECISION — accepted categories: `2 | 4`** (TestFlight and App Store), from the
   > start, so App Store release needs no cutover. Everything else is rejected, which
   > shuts out development-signed, Enterprise/ad-hoc and Developer ID builds.
   >
   > Two consequences, both easy to trip over:
   >
   > 1. **Our own Phase 4 development builds are category `3` and would be rejected.**
   >    Dev builds also run in the `development` App Attest environment (different
   >    AAGUID), so gate on that: when `APP_ATTEST_ENVIRONMENT === "development"`, also
   >    accept `3`; in production accept strictly `2|4`. This widens nothing in
   >    production, and without it plan step 44 ("run on a real device") fails against a
   >    correctly-implemented server.
   > 2. **Apple's published vector has category `1`** (an OS executable), which this
   >    policy rejects. So the accepted-category set must be **injectable**, exactly like
   >    the clock in §12 Q3 — otherwise the enrollment fixture test fails on a check that
   >    is working correctly. Pass the policy in; never read it from a module constant.
8. Only after every check passes, persist `{ keyId, publicKeySpki, counter: 0,
   environment, receipt, createdAt }`. Refuse to overwrite an existing verified record
   with differing data, and — per Apple — **verify the public key isn't already
   associated with a different user**, as an additional replay guard.

`APP_ID` is `<App ID prefix>.<bundle identifier>`. Apple's wording: the prefix "is
*usually* automatically set to be your 10-digit team identifier" — confirm it against the
Identifier entry in Certificates, Identifiers & Profiles rather than assuming.

*Not applicable to us:* the macOS-only `aclBlob` check (OID `1.2.840.113635.100.8.6`).
ClimateChat is iOS-only; do not add it.

### 5a. Protecting the pre-authentication endpoints

`/attest/challenge` and `/attest/register` cannot require an assertion — they are how a
client *becomes* able to produce one. That leaves two exposures, both now closed:

**CPU amplification.** `/attest/register` runs full X.509 chain validation plus several
SHA-256 passes on attacker-supplied bytes. **Decision: throttle both endpoints per-IP**,
using the same date-keyed KV counter pattern as `rateLimit.ts` under a separate prefix
(e.g. `rle:{ip}:{YYYY-MM-DD}`) so enrollment attempts never consume a user's question
quota, and vice versa. Suggested starting limits — **tunable, not load-bearing** — 10
challenges and 5 registrations per IP per day; enrollment is a once-per-install event, so
anything a real user does sits far below this. As with `rateLimit.ts`, the counter is
non-atomic and a race lets a couple extra through; that is acceptable for a throttle, and
unacceptable for the replay counter (§7 pitfall 6) — do not confuse the two.

Order matters here too: **throttle before validating.** The cheap counter check must
precede the expensive chain validation, or the throttle does not actually protect
anything. Same principle as the body-size check in §9.

**Durable Object creation before verification — reconsidered 2026-09-22, and the earlier
restriction is dropped.** A previous draft of this section required that the device DO be
created only *after* the attestation verified, forcing enrollment challenges into KV and
splitting challenge storage across two mechanisms. That was wrong on its own terms:

- The stated justification was "unbounded DO creation." **The per-IP throttle above
  already bounds it** — to exactly the same degree it bounds KV challenge writes. The KV
  route constrains an attacker no better. The objection predated the throttle and was not
  re-examined once the throttle made it moot.
- There is no security argument underneath it either. A `keyId` is SHA-256 of a
  hardware-generated public key, so an attacker cannot predict a victim's `keyId` to
  squat it, and an existing DO confers nothing — the key record is written only after a
  valid Apple-signed attestation verifies. An attacker-created DO is an empty box.

**Decision: the device DO is created at challenge issuance and updated in place on
successful verification.** Enrollment challenges live in that DO, alongside everything
else. Challenge storage is therefore **uniform** — one mechanism, one lookup path.

The one thing KV genuinely provided was free expiry via `expirationTtl`, which matters
for enrollments that are started and abandoned. The DO-native equivalent is an **alarm**:
set `storage.setAlarm(now + ~5 min)` when issuing an enrollment challenge, and have
`alarm()` call `deleteAll()` if the record is still unverified. A DO whose storage is
fully deleted genuinely ceases to exist — `idFromName()` allocates nothing on its own —
so this is a true reap, not a tombstone. Roughly ten lines, against a whole second
storage mechanism.

Two side benefits over the KV design: enrollment challenge consumption becomes atomic
under the same `blockConcurrencyWhile()` guard as everything else (no special-case
reasoning about eventual consistency), and it *removes* KV writes from the R4 budget
rather than adding them.

> **Constraint to design around: a Durable Object has only ONE alarm.** `setAlarm()`
> replaces any pending alarm. The same DO later holds the replay counter and assertion
> challenges, and the deferred key-lifecycle item (§11a) may want its own expiry. The
> `alarm()` handler must therefore branch on record state — unverified and past deadline
> → `deleteAll()`; verified → whatever the lifecycle policy becomes — rather than
> assuming it is always the enrollment reaper.

KV is still used for the per-IP throttle counter (`rle:{ip}:{date}`), but that is
IP-keyed infrastructure, not per-device state, so it could not live in a per-device DO
regardless. It reuses the existing `rateLimit.ts` pattern.

---

## 6. Assertion path (per request)

Read the body exactly once as bytes; those same bytes are both what we verify and what we
then `JSON.parse`. Then:

1. Load the key record for the supplied key ID.
2. CBOR-decode the assertion → `{ signature, authenticatorData }`. Runtime-validate that
   both are actually byte strings; do not trust the decoded shape because TypeScript says
   so.
3. Parse `authenticatorData`; require `rpIdHash === SHA256(APP_ID)`.
4. Require `newCounter > storedCounter` (Apple: "greater than the value from the previous
   assertion, or greater than `0` on the first assertion").
5. `clientDataHash = SHA256(clientData)`; verify the ECDSA signature (see pitfall 1 for
   exactly which bytes go into `crypto.subtle.verify`).
6. **Verify the challenge embedded in `clientData` matches the one this server issued.**
   Apple's documented step 6 — see §6a for how we satisfy this without a round-trip.
7. Verify `validationCategory` and `bundleVersion` in the assertion's `extensions` CBOR
   dictionary, same as at enrollment.
8. Advance the counter inside the DO, **wrapped in `blockConcurrencyWhile()`** (§7
   pitfall 6 — this is a rule, not a preference). The signature verification in step 5
   happens in the Worker, *outside* the DO, so the guarded region stays small: the DO
   re-reads the counter, re-checks `presented > stored`, and writes. That re-check inside
   the guard is authoritative — the value read before the crypto is advisory only.

   Concretely that means two DO interactions per request: one to load the key record, one
   to accept-and-advance. The second is the only one that decides.

### 6a. Challenge handling — revised

An earlier draft of this document proposed dropping per-request challenges and relying on
the counter alone. **Apple's documented procedure includes a challenge in assertion
`clientData` (step 6), so that deviation is withdrawn.**

The original objection — that a challenge costs a full extra HTTP round-trip before every
question — is solved without deviating: **piggyback the next challenge on each response.**
Every `/ask` response carries a freshly minted, single-use challenge for the *next*
request. Only the first call after app launch needs a standalone challenge fetch; steady
state costs zero extra round-trips. Challenges — enrollment and assertion alike — live in
the device's Durable Object alongside the counter, so issuing and consuming them is
atomic under the same `blockConcurrencyWhile()` guard (§5a).

`clientData` is therefore: the request body **plus** the current challenge. Both are
covered by the signature, which binds an assertion to one specific question *and* one
specific challenge.

---

## 7. Known pitfalls — the landmines

**1. Double-hashing the assertion (STILL UNRESOLVED after checking Apple's docs).**
Apple's assertion step 2 says "Concatenate `authenticatorData` and `clientDataHash`, and
apply a SHA256 hash over the result to form `nonce`," and step 3 says "verify that the
assertion's `signature` is valid for `nonce`." That phrasing does **not** disambiguate
the layer question, because ECDSA signs a digest: if `nonce` *is* the digest, then a
WebCrypto call — which applies SHA-256 to whatever message it's given — must be handed
`authenticatorData ‖ clientDataHash`, not `nonce`. Handing it `nonce` verifies against
`SHA256(SHA256(...))`.

Reading remains that you pass the **concatenation** and let WebCrypto hash once. Note the
asymmetry that makes this easy to get wrong: at *attestation* you compute `nonce`
explicitly (it's compared byte-for-byte against the certificate extension, no signature
involved), while at *assertion* the same value is produced implicitly inside the verify
operation. Codex's sample code computes `nonce` explicitly and then passes it to
`crypto.subtle.verify` — which double-hashes — even though its own prose warns about this
exact boundary.

**Apple's published validation guide does not settle this: it covers attestation only.**
This one genuinely needs a real device assertion to confirm. Treat the implementation as
provisional until then, and write the test so that flipping the hypothesis is a one-line
change.

**2. DER → P1363 conversion.** DER integers are signed big-endian: a value whose high bit
is set carries a leading `0x00` that must be stripped, and short values must be left-padded
to **the curve's component size** — 32 bytes for P-256, 48 for P-384 (see pitfall 7; do
not hardcode 32). Both directions are common bug sources. Tested in `spike-chain.spec.ts`,
including leading-zero integers, short components, P-384 output, and oversized integers.

**3. Key ID is the hash of the X9.62 point, not the SPKI.** See §3.

**4. Trust anchor must be pinned.** Never trust a root supplied in the client's `x5c`,
never fetch the root at runtime.

**5. Defensive CBOR decoding.** Set decoder size/shape limits before decoding untrusted
input, and enforce strict body-size limits ahead of that — an App Attest object is nowhere
near megabytes. Reject unexpected tags, overlong chains, wrong `fmt`, truncated
authenticator data, oversized key IDs/receipts.

**6. A Durable Object alone does NOT make the counter check atomic.** Proven
empirically (§12): with a `read → await(crypto work) → write` sequence, **12 of 12
concurrent claims on the same counter value were accepted** — a total replay hole, no
better than KV. "Single-threaded" means no *parallel* execution; it does not mean no
*interleaving*. Input gates hold event delivery only while a **storage operation** is in
flight. The instant the `get()` resolves the gate opens, so any non-storage `await` —
such as verifying a signature — is an open window in which every other queued handler
reads the same stale counter.

> ### RULE: every counter or challenge mutation goes inside `blockConcurrencyWhile()`.
> No exceptions, and this is not one of two equally good options.

A "tight" `read → write` with no intervening `await` also measures as safe (1 of 12), but
**do not rely on it.** It is safe only because there happens to be no yield point between
the two statements — an invariant enforced by nothing but code review. The next person to
add a log line, a metric, or a validation call with an `await` in it silently reopens the
hole, and no test fails unless this exact concurrency test exists. `blockConcurrencyWhile()`
is an explicit platform guarantee that holds no matter what runs inside it.

The usual objection — that it serializes everything hitting the object — does not apply
here: the DO is keyed **per App Attest key ID, i.e. per device**, so the only requests it
can ever block are concurrent requests from the same device, which is exactly what we
want serialized. The throughput cost is nil.

Structure the code so the guarded region stays small: verify the signature in the Worker,
*outside* the DO, then call in for a short accept-and-advance. See §6 step 8.

**7. ECDSA component size is curve-dependent.** Apple's leaf is P-256 (32-byte r/s) but
the intermediate and root are **P-384 (48-byte r/s)**. A `derToP1363` with a hardcoded 32
silently fails chain verification.

**8. The signature digest comes from the child certificate's `signatureAlgorithm` OID,
not from the issuer's curve.** Apple's leaf is `ecdsa-with-SHA256` (1.2.840.10045.4.3.2)
signed by a P-384 key; the intermediate is `ecdsa-with-SHA384`. Inferring the hash from
the key curve produces a false negative on a perfectly valid chain.

**9. `apple_validation_category_01` is a 4-byte little-endian UInt32** carried in a CBOR
*byte string*, not a CBOR integer. Reading it big-endian yields 16777216 instead of 1 —
which would silently let disallowed build categories through.

**10. Timing-safe comparison** for the nonce and any secret-equivalent bytes.
`crypto.subtle.timingSafeEqual` is available in Workers.

---

## 8. Question log

**Resolved by the §12 spike (2026-09-21):**

1. ~~Which CBOR library.~~ **`cbor-x`** — both work under workerd without `nodejs_compat`;
   `cbor-x` has zero runtime dependencies. The hand-rolled-decoder idea is unnecessary.
2. ~~Does the Peculiar stack run under workerd?~~ **`@peculiar/asn1-*` yes,
   `@peculiar/x509` no** (needs a `reflect-metadata` polyfill for its DI container).
3. ~~Does a DO-backed counter serialize?~~ **Only with `blockConcurrencyWhile()`** — the
   naive pattern is as broken as KV. See §7 pitfall 6.
4. ~~AAGUID byte values and App ID prefix.~~ AAGUIDs confirmed verbatim; the App ID prefix
   is "usually" the 10-digit team ID but must be read off the Identifier entry.

**Decided 2026-09-21:**

5. ~~Which `validationCategory` values to accept.~~ **Accept `2|4` from the start**
   (TestFlight and App Store), avoiding a hard cutover at release. See the policy block in
   §5 step 7 — two consequences follow, one of which affects Phase 4 device testing.
6. ~~Enrollment abuse.~~ **Throttle both enrollment endpoints per-IP.** See §5a. The
   companion restriction — create the DO only after verification — was **reversed on
   2026-09-22**: the throttle already bounds DO creation, so challenges stay uniformly in
   the device DO with an alarm-based reaper, instead of a second KV-based mechanism.

7. ~~Does rate limiting move from per-IP to per-key?~~ **Decided 2026-09-23: yes —
   per-`keyId` for `/ask`, per-IP retained for enrollment.** Full rationale in
   `project-plan.md` §8.3. In short: IP fails in both directions for a mobile app (CGNAT
   makes it too coarse, network switching makes it trivially cycled), while moving the
   counter into the per-device DO also removes a KV write per request against the binding
   R4 constraint and makes the check atomic for free — it rides inside the
   `blockConcurrencyWhile()` transaction the replay counter already needs (§7 pitfall 6).
   Accepted trade-off: a reinstall mints a new key and a fresh quota; per-IP has the same
   bypass more cheaply, and the spend cap bounds it either way.

   **Implementation note:** build the daily counter into the device DO from the start,
   in the same guarded transaction as the replay counter — do not write per-IP KV logic
   for `/ask` and migrate later. `rateLimit.ts` stays as-is for the transition window
   while `X-App-Secret` is still live, and retires with it.

**Still open:** nothing. All seven questions are settled.

---

## 9. Integration with the existing pipeline

- The `/ask` order becomes: read body once → **body-size check** → assertion verify →
  `parseMessages` → cache → rate limit → Claude. Assertion verification replaces
  `verifyClient` as the authentication gate.

  **The size check must come first.** An earlier draft of this section had assertion
  verification ahead of it, which would mean hashing and ECDSA-verifying an
  attacker-controlled body of unbounded size before the limit that exists to stop exactly
  that. Cheap structural checks precede expensive cryptographic ones.
- `handleAsk` currently does `request.text()` for the `MAX_BODY_LENGTH` guard. The
  assertion signs the exact request bytes, so the guard and the signature check must
  operate on the same single read.
- **`X-App-Secret` stays in place during the transition.** App Attest is two-sided and
  the iOS half doesn't exist yet; removing the header check now would break `wrangler dev`
  smoke testing and the Phase 5 smoke-test script. Retire it only once App Attest is
  proven end-to-end on a real device.
- New `Env` bindings: `APP_ATTEST_KEYS` (DurableObjectNamespace), `APPLE_APP_ID`,
  `APP_ATTEST_ENVIRONMENT` (`development` | `production` — also selects the accepted
  `validationCategory` set, see §5 step 7).
- Enrollment uses `CLIMATE_KV` only for the per-IP throttle (`rle:{ip}:{date}`), reusing
  the `rateLimit.ts` pattern. Challenges and counters live in the device DO (§5a), so the
  enrollment path adds one KV write per attempt against the R4 budget — negligible, since
  enrollment happens once per install.
- Plan steps 22, 27, 41 and 43, plus R10, will need updating when this ships.

---

## 10. Test plan (non-optional)

**Apple publishes a complete attestation known-answer vector** —
[Attestation Object Validation Guide](https://developer.apple.com/documentation/devicecheck/attestation-object-validation-guide).
It provides a worked example (`appIDPrefix = "1234567890"`, `bundleID =
"com.example.myapp"`, `serverChallenge = "example_server_challenge"`) with the expected
value at *every* step: the base64 `attestationObject` and `keyId`, the expected leaf and
intermediate certificates, the composite `authData ‖ clientDataHash`, the resulting
`nonce`, the octet string extracted from the `credCert` extension, the SHA256 of the
X9.62 public key, the App ID hash / `RP ID` hash, `counter`, `aaguid`, `credentialId`,
and both extension values. **Wire this up as the primary attestation test fixture — it
validates the entire enrollment path with no device required.**

The machine-readable source is Apple's docs JSON API, not the HTML page (the docs site is
a JS app, so a plain fetch returns only the shell):
`https://developer.apple.com/tutorials/data/documentation/devicecheck/attestation-object-validation-guide.json`
— walk `primaryContentSections`. The extracted values are committed in
`worker/test/fixtures/apple_appattest_vector.json`; re-fetch from Apple rather than
trusting that copy if anything looks off.

Remaining fixtures that *do* need a physical device: a real assertion from an attested
key (the only way to settle pitfall 1).

Rejection cases: mutated challenge, mutated body, wrong App ID, wrong AAGUID/environment,
broken chain, expired certificate, bad nonce extension, key ID derived from SPKI instead
of the X9.62 point, truncated authenticator data, malformed CBOR, DER signature with
leading-zero integers, reused counter, lower counter, two concurrent requests racing one
counter, oversized CBOR input, and a disallowed `validationCategory`.

Cases added by the 2026-09-21 decisions (§8 items 5 and 6):

- **`validationCategory` policy** — `2` and `4` accepted; `1`, `3`, `5`, `6`, `10`
  rejected in production. Separately assert that a `development` environment *does*
  accept `3`, and that the accepted set is injectable — Apple's own vector is category
  `1`, so the enrollment fixture test must pass its own policy in rather than inherit the
  production one.
- **Enrollment throttle** — the per-IP counter trips at the configured limit, the
  throttle is checked *before* chain validation (assert no expensive work runs on a
  throttled request), and enrollment attempts do not decrement a user's question quota.
- **Abandoned enrollment is reaped** — issue a challenge, never register, fire the alarm,
  and assert the DO's storage is empty afterwards. This replaces the earlier "no DO on
  failure" test and is what makes alarm-based cleanup real rather than a comment.
- **The alarm branches on state** — a *verified* record must survive the alarm firing.
  Given one alarm per DO, a reaper that deletes unconditionally would wipe live devices.
- **Enrollment challenge** — unknown, expired and already-consumed challenges are all
  rejected, and consumption is atomic (two concurrent registrations against one challenge
  yield exactly one success).

---

## 11. Sequencing — and the blocker to be honest about

App Attest is a two-sided protocol: only the iOS app can generate attestations and
assertions via `DCAppAttestService`, and Phase 4 is still gated on the UI Design Spec
(plan Section 5).

**Revised 2026-09-21 — this blocker is much smaller than first assessed.** An earlier
draft claimed the verifier couldn't be validated at all without a physical device. That
was wrong: Apple's Attestation Object Validation Guide (§10) is a complete known-answer
vector for the entire enrollment path — the X.509-heavy, most bug-prone half of this
subsystem is fully testable today, on this machine, with no device and no Xcode.

What genuinely still needs hardware:

1. **The assertion path**, and specifically pitfall 1. No published vector covers
   assertions, so that one hypothesis stays provisional until a real device produces one.
2. **End-to-end confirmation.** App Attest does **not** work in the iOS Simulator (real
   hardware only), so plan step 43's Simulator run-through needs a dev-mode bypass or a
   real-device carve-out.

Recommended order: ~~(a) run the §8 spike~~ **done, see §12**; (b) settle the §8 open
decisions 5–7; (c) build and *fully validate* the enrollment verifier against Apple's
published vector; (d) build the assertion verifier, structured so pitfall 1's hypothesis
is a one-line flip; (e) leave `X-App-Secret` active throughout; (f) capture a real
assertion during Phase 4 on a physical device, settle pitfall 1, then cut over.

### 11a. Deferred to implementation — not blockers, but do not lose them

- **Defensive CBOR limits were never exercised.** Pitfall 5 calls for decoder size/shape
  limits on untrusted input; the spike only ever decoded Apple's well-formed vector.
  `cbor-x`'s `setMaxLimits` is assumed to work under workerd and has not been verified,
  and there is no test for malformed/oversized/unexpected-tag CBOR. Verify when building
  the real decoder.
- **`crypto.subtle.timingSafeEqual` is unexercised.** Documented as available in Workers
  and used nowhere yet; `spikeChain.ts` uses a hand-rolled XOR compare for certificate
  *names* (not secret, so fine). The nonce comparison is the one that needs it.
- **Error taxonomy.** App Attest failures must map into the existing `logError` class
  scheme (plan step 16) rather than inventing a parallel one, and responses must not leak
  whether a given `keyId` exists. Unknown key, bad signature, replayed counter and stale
  challenge should be one opaque 401 outward, distinct classes inward.
- **Key lifecycle.** A reinstall or device restore produces a *new* key and therefore a
  new DO; nothing currently expires the old record. Decide a TTL or accept unbounded
  growth (small, but unbounded).
- **Receipt handling is stored but unused.** Apple's receipt supports a server-to-server
  fraud metric (attested-key count per device). Explicitly deferred, not forgotten.
- **`extKeyUsage` is tolerated as critical without being processed.** RFC 5280 says a
  critical extension must be *processed*; our allowlist currently lets `2.5.29.37` pass
  unexamined. Apple marks it non-critical, so this is theoretical today — tighten or
  document when promoting.
- **Environment switching.** The `development`/`production` App Attest environment is
  driven by the app entitlement, so the expected AAGUID changes between a Phase 4 dev
  build and a TestFlight build. `APP_ATTEST_ENVIRONMENT` must be deployment-configurable,
  and flipping it is a release step with a matching Worker change.

---

## 12. Spike results (2026-09-21)

Run on branch `spike-app-attest`. Four spike specs under `worker/test/`
(`spike-appattest`, `spike-x509`, `spike-do-atomicity`, `spike-chain`) plus
`worker/src/spikeCounter.ts`, `worker/src/spikeChain.ts` and Apple's vector in
`worker/test/fixtures/apple_appattest_vector.json`. All **138** tests and lint pass
(108 pre-existing + 30 spike, no regressions).

**Most of this is throwaway scaffolding that proves an approach — with one exception.**
`spikeChain.ts` and `spike-chain.spec.ts` are the finished chain validator and are meant
for promotion, not deletion (see the teardown checklist). Everything else exists to
answer a question and can be discarded once the answer is recorded here.

### Q1 — CBOR under workerd: both work, `cbor-x` wins
Both `cbor-x` and `cbor2` import and correctly decode Apple's attestation object inside
workerd with no `nodejs_compat` flag. `cbor-x` has **zero** runtime dependencies against
`cbor2`'s one, so it wins on the stated criterion. The hand-rolled-decoder option is
unnecessary — neither library costs us anything meaningful.

### Q2 — X.509 under workerd: `@peculiar/x509` fails; the ASN.1 packages succeed
`@peculiar/x509` throws `tsyringe requires a reflect polyfill` on import — it ships a
dependency-injection container. Importing `reflect-metadata` first fixes it, but that is
two extra dependencies (one of them a DI framework) on a security path. Using
`@peculiar/asn1-schema` + `@peculiar/asn1-x509` **directly** needs no DI and no polyfill,
and was enough to do everything required: enumerate extension OIDs, pull the nonce
extension, serialize the SPKI, and serialize `TBSCertificate` for signature checks.

### Q3 — Chain validation with native WebCrypto: complete, no chain library
Implemented in **`worker/src/spikeChain.ts`** (the one spike file intended for promotion)
and exercised by `worker/test/spike-chain.spec.ts` — 19 tests. `verifyChain(x5c, {now,
rootDer})` returns either the leaf SPKI or a typed `ChainFailure` reason, so tests assert
*which* check fired rather than merely "rejected".

Signature verification uses only `crypto.subtle.verify` plus a hand-written DER→P1363
converter; two traps found along the way are recorded as §7 pitfalls 7 and 8. On top of
that, the validator enforces the full RFC 5280-flavoured policy the earlier draft was
missing: validity windows against an injectable clock, issuer/subject name chaining at
each hop, `basicConstraints` (leaf must not be a CA; both issuers must be), `keyUsage`
(issuers need `keyCertSign`), rejection of unrecognised **critical** extensions, an
ECDSA-only signature-algorithm allowlist, a self-issued trust anchor, and an exact
`x5c.length === 2`. Revocation is deliberately skipped — Apple's leaves live ~3 days and
the chain is pinned to one hardcoded root.

Every check has a negative test that makes it fire:

| Check | How it's provoked |
|---|---|
| `cert_expired` / `cert_not_yet_valid` | Apple's real vector at today's date / before issuance, plus both notAfter boundaries |
| `bad_x5c_length` | 1 and 3 certificates |
| `leaf_is_ca` | the CA intermediate placed in the leaf slot |
| `issuer_not_ca` | the non-CA leaf placed in the issuer slot |
| `issuer_lacks_key_cert_sign` | intermediate's `keyUsage` rewritten to digitalSignature only |
| `name_chain_broken` | root placed in the intermediate slot |
| `root_not_self_issued` | intermediate passed as the trust anchor |
| `unknown_critical_extension` | a bogus **critical** OID injected into the leaf |
| *(tolerance)* | a bogus **non-critical** OID must NOT trip the rule — it falls through to `bad_signature` |
| `bad_signature` | last byte of the leaf signature flipped |
| `unsupported_signature_algorithm` | `signatureAlgorithm` swapped to sha256WithRSA |
| `unsupported_curve` | intermediate's SPKI curve OID corrupted |
| `derToP1363` edge cases | DER sign-byte stripping, short-component left-padding, P-384 96-byte output, oversized integer |

**The tests were mutation-tested.** Disabling the validity check failed exactly the three
validity tests; disabling the critical-extension check failed exactly that test, falling
through to `bad_signature` — which also confirms check ordering. A hand-rolled validator
whose tests have never been shown to fail is not evidence of anything.

**The clock must be injectable, and this is not optional.** Apple's sample leaf was valid
**2026-04-20 → 2026-04-23** — a three-day certificate that expired months ago. The moment
a correct `notAfter` check exists, Apple's own published vector fails it. The fixture test
pins `now` to 2026-04-21; the expired-leaf negative test just passes today's date. Written
in the other order, this would have looked like a broken implementation rather than an
expired fixture.

### Q4 — Durable Object atomicity: the most important result
Measured with 12 concurrent RPC calls presenting the same counter value:

| Pattern | Accepted | Verdict |
|---|---|---|
| `read → await(crypto) → write` | **12 / 12** | **Replay hole** |
| `read → write`, no await between | 1 / 12 | Safe |
| `blockConcurrencyWhile(read → await → write)` | 1 / 12 | Safe |
| Same race against KV | 12 / 12 | Confirms KV is unusable |

So "use a Durable Object" is necessary but **not sufficient** — the naive pattern is
exactly as broken as KV, and the naive pattern is what a reasonable person writes.

**Resulting rule: all counter/challenge mutation goes inside `blockConcurrencyWhile()`**
(§7 pitfall 6). The tight variant measures as safe too, but its safety is an emergent
property of there being no yield point between the two statements — not a guarantee —
and any future `await` inserted between them silently restores the 12-of-12 hole. Note
also that `checkNaive` in the spike *is* `checkTight` plus one `await`: the two spike
tests sitting side by side are the demonstration of how little it takes to break.

There is a second reason to prefer the explicit primitive. This ran under local
simulation, and of the two results, "naive is broken" is the trustworthy one — it matches
documented input-gate semantics, and being wrong about it in production would only mean
we were safer than measured. "Tight is fine" is the result most likely to vary across
runtime versions. Depending on it means depending on the measurement that deserves the
least confidence.

*Methodology note:* `runInDurableObject()` invokes the instance directly and **bypasses
input gates**, reporting 12/12 even for the safe patterns. Atomicity must be tested
through the stub RPC path. An earlier version of this spike drew the wrong conclusion
from exactly that mistake.

### Bonus — two errors in Apple's own published validation guide

1. **The vector contradicts the prose on `clientDataHash`.** Apple's step 2 says to use
   `SHA256(challenge)`, but their published composite ends with the **raw** challenge
   bytes, and the nonce sealed in the credCert — ground truth, produced by the Secure
   Enclave — reproduces *only* from the raw form:
   - `SHA256(authData ‖ rawChallenge)` → `h7fQbZOkKU5G8BHma2zEAPC6sgcpl2xhlYC0KuYL/24=` ✅ matches credCert
   - `SHA256(authData ‖ SHA256(challenge))` → `HRzniRKJfeiM/p/OVSGqs3q/sJ3FRIM/8RVhJVLPdfM=` ❌

   The real rule is that `clientDataHash` is *whatever bytes the app passed to
   `attestKey()`*, and the server must use the identical bytes. **Action for us: pick the
   convention explicitly, document it on both sides, and note that our test against
   Apple's vector must use the raw form even though our own app will hash.** Anyone who
   implements from the prose and tests against the vector will see a correct
   implementation fail.

2. **The guide's stated "expected public key SHA256" is simply wrong.** It prints
   `inGjK2JbaAEhAsYwCns2zTyZDzsJ3OKx3Q2nnxk+mkY=`, which does not equal the `keyId` that
   the same step says it must match. Our computed `SHA256(X9.62 uncompressed point)` came
   out as `zgSY9YSD+7TaDXssY6WlOPVS1K3Lmk+pFhlcSWE+ZV0=`, which **does** equal the keyId
   and the `credentialId`. The documented procedure is right; the printed value is not.

### Revised dependency total
`cbor-x` (0 deps) + `@peculiar/asn1-schema` + `@peculiar/asn1-x509`. Everything
cryptographic is native `crypto.subtle`. Down from Codex's proposed four packages
(~22 transitively) and from this document's own earlier `@noble/curves` proposal.

### Teardown checklist when promoting to real code
**Keep and promote:** `src/spikeChain.ts` (rename to `src/appAttest/chain.ts`) and
`test/spike-chain.spec.ts` with it — that pair is the finished chain validator, not
scaffolding. Keep `test/fixtures/apple_appattest_vector.json`; it becomes the real
enrollment fixture.

**Delete:** `src/spikeCounter.ts` and its re-export in `src/index.ts`,
`test/spike-env.d.ts`, the `SPIKE_COUNTER` entry in `vitest.config.mts`, and
`spike-appattest.spec.ts` / `spike-x509.spec.ts` / `spike-do-atomicity.spec.ts` /
`spike-alarm.spec.ts` (their findings are captured in this document).

**Note `wrangler.jsonc` is deliberately untouched.** The spike's Durable Object binding
lives in `vitest.config.mts` under `miniflare.durableObjects`, not in the deployable
config. A DO declared in `wrangler.jsonc` requires a `migrations` entry, and migrations
are append-only history: the first real `wrangler deploy` (plan step 40) would register
the class in production, after which removing it needs a further `deleted_classes`
migration, and deleting the code without that makes the deploy fail outright. Miniflare
simulates Durable Objects locally with no migration concept, so the tests need nothing
in the deployable config. **Scaffolding must never leave a permanent mark on production
migration history** — apply the same rule to any future spike that wants a DO.

**Dependencies — mostly done already (2026-09-23).** `cbor2`, `@peculiar/x509` and
`reflect-metadata` have been removed, along with the two tests that exercised them (their
findings survive in Q1/Q2 above). `@peculiar/asn1-schema` and `@peculiar/asn1-x509` are
now in `dependencies`, because `src/spikeChain.ts` genuinely imports them.

**`cbor-x` is deliberately still a devDependency** — nothing in `src/` imports it yet, so
that is its honest classification today. It must move to `dependencies` when the real
CBOR decoding is written, and **that move is enforced, not remembered**:
`import-x/no-extraneous-dependencies` (eslint-plugin-import-x) is configured in
`eslint.config.mjs` to error when anything under `src/**` imports a devDependency. Lint
gates deploy, so the promotion is forced at exactly the moment production code first
imports it.

Why that guard exists: importing a devDependency from `src/` **builds and bundles
perfectly well** — verified with `wrangler deploy --dry-run`, which happily emitted
`cbor-x` into the bundle. esbuild resolves from `node_modules` and ignores which
package.json section declared it, so the mistake is invisible until a production-only
install (`npm ci --omit=dev`) fails. A checklist entry would not have caught it.

**One remaining production footprint:** `src/index.ts` re-exports `SpikeCounter`, because
Miniflare needs the class exported from the entry module to bind it in tests. It pulls in
no libraries (~1 KB of dead code) but it *does* appear in the built bundle. Remove the
export with `src/spikeCounter.ts` — and note this is the only spike artifact that would
reach production if a deploy happened before teardown.

### Q5 — Alarm-based reaping: verified, and the one-alarm constraint is real

Added 2026-09-22, after §5a was rewritten to drop the KV challenge store and rely on a DO
alarm instead. That rewrite made alarms load-bearing while nothing had tested them — the
same "assume it works" posture that Q2 and Q4 both punished. `spike-alarm.spec.ts`,
5 tests:

| Claim | Result |
|---|---|
| `alarm()` fires and `deleteAll()` reaps an abandoned enrollment | ✅ storage empties |
| A **verified** record survives the alarm (state-branching reaper) | ✅ record intact |
| `setAlarm()` **replaces** a pending alarm, never queues a second | ✅ second fire returns `false` |
| Consuming a challenge makes a second registration fail | ✅ |
| 12 concurrent registrations against one challenge | ✅ exactly 1 success |

**Mutation-tested**: making the reaper unconditional (`deleteAll()` with no state check)
fails exactly the "verified survives" test and nothing else. That is the test standing
between us and a reaper that wipes live devices, so it needed to be shown to fail.

Two details worth carrying into the implementation:

- **`deleteAll()` also clears the pending alarm** — `getAlarm()` returns `null` after the
  reap, so no explicit `deleteAlarm()` is needed on that path. (`reset()` in the spike
  calls both only because it is a test helper that must work from any state.)
- **The one-alarm-per-DO constraint is confirmed empirically**, not just from docs:
  re-arming moved the scheduled time rather than adding a second alarm, and firing once
  exhausted it. The `alarm()` handler must therefore branch on record state, exactly as
  §5a requires — this is not a theoretical concern.

The enrollment-challenge atomicity claim in §5a is also now evidence rather than
assertion: 12 concurrent `completeRegistration()` calls against a single pending
challenge produced one winner, under the same `blockConcurrencyWhile()` guard as the
replay counter.
