export type Env = {
  DB: D1Database;
  ASSETS: Fetcher;
  // Secrets — .dev.vars locally, `wrangler secret put` in prod:
  ANTHROPIC_API_KEY: string;
  DYNAMIC_API_KEY: string;
  DYNAMIC_ENV_ID: string;
  UNLINK_API_KEY: string;
  ARC_RPC_URL: string;
  TREASURY_WALLET_ID: string;
  TREASURY_WALLET_ADDRESS: string;
  // Node sidecar that holds the Dynamic MPC SDK (native binary, can't run in workerd):
  SIGNER_SIDECAR_URL: string;
  SIGNER_SIDECAR_SECRET: string;
};
