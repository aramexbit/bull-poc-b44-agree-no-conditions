#!/bin/bash
# Run the B-44 PoC end to end: forge test (Minor5A) + node live-SDK modes.
# Exits 0 when the bug reproduces, 1 when it does not.
# Local only: fresh Anvil 4663 per mode, mock API, live SDK verbatim.
# No mainnet, no real funds, no Bull infrastructure.
set -u
cd "$(dirname "$0")"
FORGE="${FORGE:-$HOME/.foundry/bin/forge}"
echo "=== forge: chain/test/Minor5A.t.sol ==="
(cd chain && "$FORGE" test --match-contract Minor5ATest 2>&1 | tee ../forge-staging.log)
if ! grep -q "3 passed" forge-staging.log; then
  echo "B-44 NOT reproduced (forge did not pass 3/3)"
  exit 1
fi
echo "=== node: run-sdk-agree5.mjs k2049 k2049c k2049z ==="
bash run-node.sh k2049 k2049c k2049z 2>&1 | tee run-staging.log
if grep -q '"delayOnly": true' node-result-k2049.json && grep -q '"payeeGainedUsdg": "500"' node-result-k2049c.json && grep -q '"noAgreementCreated": true' node-result-k2049z.json; then
  echo "B-44 reproduced: agree() without conditions sends attacker-attest, payee never paid (3/3 node modes green, forge 3/3)"
  exit 0
fi
echo "B-44 NOT reproduced (node results mismatch)"
exit 1
