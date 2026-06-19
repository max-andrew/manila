export type Env = {
  DB: D1Database;
  ASSETS: Fetcher;
  AI: Ai;
  // The Workers AI model that powers the agent (overridable; see wrangler.jsonc):
  AGENT_MODEL: string;
  // Secrets — .dev.vars locally, `wrangler secret put` in prod:
  DYNAMIC_API_KEY: string;
  DYNAMIC_ENV_ID: string;
  UNLINK_API_KEY: string;
  TREASURY_UNLINK_MNEMONIC: string;
  // Privacy-pool token on the Unlink network. On arc-testnet this is the mock
  // USDCm, not native USDC. Defaults to native USDC if unset.
  UNLINK_TOKEN_ADDRESS: string;
  UNLINK_TOKEN_DECIMALS: string;
  ARC_RPC_URL: string;
  TREASURY_WALLET_ID: string;
  TREASURY_WALLET_ADDRESS: string;
  // Platform fee collector for the $0.001-per-disbursement x402 nanopayments:
  SEAL_FEE_ADDRESS: string;
  // The Dynamic MPC signer runs in a Cloudflare Container (native binary can't
  // run in workerd) reached through this Durable Object binding — see
  // signer-container.ts. The Worker forwards the secrets to the container.
  SIGNER: DurableObjectNamespace<import('./signer-container').SignerContainer>;
  SIGNER_SIDECAR_SECRET: string;
  SIDECAR_WALLET_PASSWORD: string;
};
