# Bull SDK `agree()`: omitted `conditions` are never verified — server adds an attacker-attest condition and the payee is never paid

**Report:** B-44 (Minor) — Bull.family bug bounty
**Location:** SDK `agree()` — https://www.bull.family/sdk/bull.mjs (live version, sha256 `f450d44df1812a6b9254c7b8cbac8aab89e94301cb86727f439643dfad47efae`, 54,263 B), lines ~393–405
**Severity:** Minor (honestly Minor — delay-only for the payer, unpaid work for the payee; funds are refunded in full after expiry)

## What is the bug?

`agree()` verifies the conditions the caller passes — but `conditions` is
optional in the signature, and when it is omitted the verification is
skipped entirely:

```js
const expect = Array.isArray(conditions) ? await this.#expectConditions(conditions) : null;
// ...
if (expect) this.#matchConditions(p.conditions, expect);
```

The post-create check reads only payer/payee/amount/asset/termsHash from
`AgreementCreated` — never the conditions. A compromised/malicious API
server (the SDK's own documented threat model) can attach ANY conditions
to an agreement created by a caller who omits `conditions`, e.g. `attest`
by an attacker who never attests. The payee does the work named in `terms`
and is never paid; the payer's funds sit locked until expiry, then refund.

## How to reproduce

Local only — fresh Anvil chain 4663, mock malicious Bull API, the LIVE SDK
verbatim (`sdk-live.mjs`), live Agreement v4.1 bytecode etched with the fee
signer zeroed. No real funds, no mainnet, no Bull infrastructure.

```sh
./run.sh        # forge test (3/3) + node live-SDK modes k2049/k2049c/k2049z
```

What the PoC does — victim calls `agree({ payee, asset: "usdg", amount:
"500", terms: "Deliver the report", expiryHours: 72 })` with NO conditions:

- **k2049 (main):** mock server returns attest-by-attacker; the real SDK
  SENDS with no error; release blocked immediately AND at expiry; stranger
  refund after expiry returns the payer whole 500, payee gains 0 —
  `delayOnly: true`.
- **k2049c (control):** caller passes `conditions: [{type: "attest", by:
  arbiter}]`; SDK sends; arbiter attests; release succeeds; payee +500.
- **k2049z:** server returns ZERO conditions; the SDK sends the transaction
  but on-chain creation REVERTS (`0x2bb9acf7` BadInput) — the zero-condition
  leg is dead at the contract layer (Agreement v4.1 requires >= 1
  condition), so the only live server choice is a blocking condition.
- **Forge (chain/test/Minor5A.t.sol, 3/3):** zero conditions create reverts;
  attacker-attest blocks release and refunds whole after expiry (payer +500,
  payee 0); honest attest releases +500.

Measured (22 Nov 2026, fresh Anvil per mode):

```
[K-2049 agree() no conditions, server attest-by-attacker] {"sdkSent":true,"agreementId":"1","releaseImmediatelyBlocked":true,"releaseAtExpiryBlocked":true,"strangerRefundAfterExpiry":true,"payerRestoredToPreDeal":true,"payeeGainedUsdg":"0","delayOnly":true}
[K-2049c CONTROL agree() with attest-by-arbiter] {"sdkSent":true,"agreementId":"1","releaseBeforeAttestBlocked":true,"arbiterAttested":true,"releasedAfterAttest":true,"payeeGainedUsdg":"500"}
[K-2049z agree() no conditions, server ZERO conditions] {"sdkSent":false,"sdkThrew":"Execution reverted with reason: custom error 0x2bb9acf7...","agreementId":null,"sdkCheckPassedChainReverted":true,"noAgreementCreated":true}
```

## Impact

500 USDG unusable for the full 72-hour expiry window per agreement
(uncapped in general; longer with a longer `expiryHours`), and the payee
receives 0 even after doing the work. After expiry the payer is refunded in
full — delay-only for the payer, unpaid work for the payee — hence Minor.
Delay-only with real user impact is Minor in this program (precedent: B-40,
recurring expiry unpinned, refund delayed 78 days, filed and submitted as
Minor).

## Suggested fix

In `agree()`, require `conditions` — throw if it is missing or empty — so
the minimal call shape fails loudly instead of silently skipping
verification. Do NOT "fix" this by defaulting omitted conditions to zero
conditions: Agreement v4.1 REVERTS creation with zero conditions (proven by
forge K-2049a and node k2049z), so an `expect = []` default would make
every such call fail on-chain instead of protecting it.

## Dedupe

- **Not B-28.** B-28 (burned, never submitted) requires omitting BOTH
  `conditions` AND `expiryHours` (attacker-attest + 100-year expiry =
  indefinite lock). Its own draft states the carve-out verbatim: "Omitting
  only one parameter is not enough to lose funds (conditions omitted +
  expiry passed: locked at most until the passed expiry, then refundable;
  expiry omitted + conditions passed: release still works on the honest
  conditions, only the refund is delayed). The finding genuinely needs both
  omissions." This report IS that carved-out single-omission case
  (conditions omitted, expiry passed): bounded harm, different fix.
- **Not B-23.** B-23 is about `deal()`: template checks verify kind+target
  only, never condition data/value. Its own text says "`agree()` already
  verifies conditions fully" — false exactly when `conditions` is omitted.
  Different entry point, different check code, different fix.
- **Not B-04.** B-04 was the OLD SDK's `agree()` checking only payer/payee.
  The current SDK verifies conditions — but only when they are passed. This
  is the omitted-params residue of that patch, not the old bug.
- **Not B-40/B-38.** Those are `deal()` expiry defects. Here the expiry is
  caller-pinned and correct; only the conditions are unverified.
- **Third party:** GitHub sweep (Minor 5, Team A): contract addresses,
  `BullEscrowV3`, `bull_sign_terms`, `relayToBull`, `checkBridge` — 0
  relevant hits; 4 known third-party repos byte-identical; minachan-sec/
  bull-poc still 404. No third-party claim of an `agree()`
  omitted-conditions gap.
- **Dedupe risk, stated honestly:** MEDIUM. A reviewer could still view
  this as B-04/B-28 residue or caller underspecification, since the docstring
  example passes `conditions`. Counter-argument: the B-28 draft's own
  carve-out, the SDK signature making `conditions` optional, the headline
  promise ("Every transaction it returns is checked before it is sent")
  being unconditional, and a different fix from B-28's.

## Files

- `run.sh` — end-to-end: forge test + node modes k2049/k2049c/k2049z
- `run-sdk-agree5.mjs` — live-SDK node runner (mock malicious API + Anvil)
- `run-node.sh` — fresh Anvil per mode driver
- `sdk-live.mjs` — live SDK verbatim (sha `f450d44d…`, 54,263 B)
- `chain/` — Foundry project (test/Minor5A.t.sol, src/, bytecode/)
- `mocks/MockERC20.json` — mock USDG token ABI/bytecode
- `node-result-k2049*.json` — recorded node results (generated by run.sh)
