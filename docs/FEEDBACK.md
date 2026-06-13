# Sponsor DX feedback

Honest notes from integrating each SDK during the build — what worked, what cost us time. Offered in good faith; these are young SDKs and the feedback is meant to help.

## Dynamic (server wallets)

What worked: the API-token + environment-ID flow is clean, and `createWalletAccount({ backUpToDynamic: true })` gave us a stateless server wallet (no key-share storage to manage) on the first try. `signTypedData` accepts arbitrary EIP-712, which is what let us sign Circle's x402 batch authorizations with the same wallet — that composability is the whole reason the project works.

What cost time:
- **`@dynamic-labs-wallet/node-evm` ships a native `.node` MPC binary**, so it can't load in Cloudflare Workers (or any edge/V8-isolate runtime). We confirmed this by probing in `workerd` and ended up running a Node sidecar just for signing. A clear "runtime requirements: Node only, native binary" note near the top of the server-wallet docs would have saved an hour of probing.
- **A transitive dep (`tslib`, via `@zerodev/ecdsa-validator`) wasn't hoisted**, so the sidecar crashed on first run with `Cannot find module 'tslib'`. Pinning or declaring it would avoid a confusing first-run failure.
- `getWallets()` logs a deprecation warning on every startup pointing to `getWalletByAddress()`, but the recovery example still uses `getWallets()`.

## Unlink (private transfers)

What worked: offline account derivation (`account.fromMnemonic(...).getAddress()`) needs no API key or network — we generated all four accounts locally and registered them later, which is a clean separation. `transfer()` and `tx.wait()` returning `{ txId, status, txHash }` is exactly right. The Dynamic × Unlink × Arc tri-party guide was the single most useful doc.

What cost time:
- **The faucet token was the biggest time sink.** On arc-testnet the privacy pool settles *mock* tokens (`ULNKm`/`USDCm`/`USDTm`), not native USDC — but passing the native USDC address returns only `invalid token: token not supported by faucet`, with no hint of what *is* supported. `getEnvironmentInfo()` returns pool/chain config but no token list, and there's no `/tokens` endpoint. We only resolved it by funding the treasury from the dashboard and reading the token address back out of `getBalances()`. A supported-token list in env-info (or the error message) would fix this instantly.
- **`USDCm` is 18 decimals**, not 6 like real USDC — surprising for a USD stand-in, and easy to get silently wrong in amount math.
- **The `/admin` entry maps to `null` under the `browser` export condition**, so bundlers that resolve browser conditions (wrangler/esbuild) fail with `Could not resolve "@unlink-xyz/sdk/admin"`. We added a wrangler `alias`. A `node`/`worker` export condition would remove the need.
- The `@canary` install tag requirement isn't obvious from the package page.

## Circle — Gateway + Arc

What worked: the x402 buyer needs **no API key — just an EOA**, which is excellent DX. `getSupported()` advertising each network's `verifyingContract` and `assets` live made our seal endpoint self-configuring (we read the Arc kind at request time rather than hardcoding). `depositFor(token, depositor, amount)` was exactly the primitive we needed to fund an MPC wallet's Gateway balance from a separate funded EOA without the MPC wallet's key — well-designed. Native USDC as the gas token on Arc just worked.

What cost time:
- **`@circle-fin/x402-batching`'s seller side is Express-shaped** (`(req, res, next)` middleware). Porting to Hono on Workers meant reading the source to learn the exact header names (`PAYMENT-REQUIRED` / `payment-signature` / `PAYMENT-RESPONSE`) and base64-JSON envelope format. A framework-agnostic core (verify/settle given a payload + requirements) would make non-Express integrations much easier.
- The USDC asset lives at `kind.extra.assets[].address` (find by `symbol`), which we initially read from the wrong field — easy to miss without an example.
- The Arc faucet's 20 USDC / 2h / address limit is tight when provisioning several wallets for one demo.
