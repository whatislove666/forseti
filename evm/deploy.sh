#!/bin/sh
# Deploys Forseti.sol (signer = the NEAR contract's Chain Signatures address) and DemoMarkets.sol.
# Usage: ./deploy.sh [rpc url]                    full deploy (default: Base Sepolia)
#        ./deploy.sh demo <verifier> [rpc url]    only DemoMarkets, against an existing Forseti.sol
# Reads EVM_PRIVATE_KEY from ../.env; that account becomes the DemoMarkets operator.
set -e
cd "$(dirname "$0")"
set -a; . ../.env; set +a
if [ "$1" = demo ]; then
  FORSETI="${2:?usage: ./deploy.sh demo <verifier> [rpc url]}"
  RPC="${3:-https://sepolia.base.org}"
else
  RPC="${1:-https://sepolia.base.org}"
  SIGNER="$(cd ../executor && node --env-file=../.env evm-signer.mjs)"
  echo "MPC signer: $SIGNER"
  FORSETI=$(forge create src/Forseti.sol:Forseti --rpc-url "$RPC" --private-key "$EVM_PRIVATE_KEY" --broadcast --constructor-args "$SIGNER" | awk '/Deployed to/{print $3}')
  echo "Forseti:     $FORSETI"
fi
MARKETS=$(forge create src/DemoMarkets.sol:DemoMarkets --rpc-url "$RPC" --private-key "$EVM_PRIVATE_KEY" --broadcast --constructor-args "$FORSETI" | awk '/Deployed to/{print $3}')
echo "DemoMarkets: $MARKETS"
