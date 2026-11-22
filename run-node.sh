#!/bin/bash
# ROUND 25-C node runner driver: fresh Anvil per mode, then one node mode.
# Usage: bash run-node.sh [mode ...]   (default: all modes)
set -u
cd "$(dirname "$0")"
ANVIL="$HOME/.foundry/bin/anvil"
MODES="${*:-k2049 k2049c k2049z}"
for m in $MODES; do
  echo "=== MODE $m ==="
  "$ANVIL" --port 8548 --chain-id 4663 > "anvil-$m.log" 2>&1 &
  APID=$!
  for i in $(seq 1 30); do
    curl -s -X POST -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' http://127.0.0.1:8548 >/dev/null 2>&1 && break
    sleep 0.5
  done
  node run-sdk-agree5.mjs "$m" > "node-$m.log" 2>&1
  echo "node $m exit=$?"
  kill $APID 2>/dev/null; wait $APID 2>/dev/null
  sleep 1
done
echo "=== SUMMARY ==="
grep -h "^\[" node-k*.log 2>/dev/null
