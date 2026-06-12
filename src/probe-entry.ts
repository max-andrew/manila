// Temporary M1 de-risking probe — NOT part of the app. Verifies each SDK
// bundles and initializes inside workerd before we build on it. Deleted after M1.

export default {
  async fetch(): Promise<Response> {
    const results: Record<string, string> = {};

    const probe = async (name: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
        results[name] = 'ok';
      } catch (err) {
        results[name] = `FAIL: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`;
      }
    };

    await probe('viem', async () => {
      const { createPublicClient, http } = await import('viem');
      const { generatePrivateKey, privateKeyToAccount } = await import('viem/accounts');
      const account = privateKeyToAccount(generatePrivateKey());
      createPublicClient({ transport: http('https://rpc.testnet.arc.network') });
      if (!account.address) throw new Error('no address');
    });

    await probe('anthropic', async () => {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      new Anthropic({ apiKey: 'probe-not-a-key' });
    });

    // @dynamic-labs-wallet/node-evm confirmed NOT Workers-compatible: it
    // requires a native .node MPC binary. Signing runs in a Node sidecar instead.

    await probe('unlink', async () => {
      const mod = await import('@unlink-xyz/sdk/client');
      results['unlink-exports'] = Object.keys(mod).slice(0, 12).join(',');
    });

    await probe('gateway-client', async () => {
      const { GatewayClient, registerBatchScheme, CHAIN_CONFIGS } = await import(
        '@circle-fin/x402-batching/client'
      );
      if (!GatewayClient || !registerBatchScheme) throw new Error('missing exports');
      results['arc-config'] = JSON.stringify(CHAIN_CONFIGS.arcTestnet ?? null);
      const { generatePrivateKey } = await import('viem/accounts');
      // construct with a throwaway key to catch constructor-time Node deps
      new GatewayClient({ chain: 'arcTestnet', privateKey: generatePrivateKey() });
    });

    await probe('gateway-server', async () => {
      const mod = await import('@circle-fin/x402-batching/server');
      results['gateway-server-exports'] = Object.keys(mod).slice(0, 12).join(',');
    });

    await probe('x402-core-client', async () => {
      const mod = await import('@x402/core/client');
      results['x402-client-exports'] = Object.keys(mod).slice(0, 12).join(',');
    });

    await probe('x402-core-server', async () => {
      const mod = await import('@x402/core/server');
      results['x402-server-exports'] = Object.keys(mod).slice(0, 12).join(',');
    });

    return Response.json(results);
  },
};
