import { createPublicClient, http } from 'viem';
import { getEnsAddress, getEnsName } from 'viem/actions';
import { sepolia } from 'viem/chains';
import { ENV } from '../config/env.config';

// ── ENS client — Sepolia only ─────────────────────────────────────────────────
// ENS lives on Ethereum, not Base Sepolia. Separate client required.
// viem auto-configures the universal resolver when chain: sepolia is set.

const ensClient = createPublicClient({
    chain: sepolia,
    transport: http(ENV.ENS_RPC_URL),
});

// ── Exported functions ────────────────────────────────────────────────────────

/**
 * Resolves an ENS name to a wallet address.
 * e.g. "dell-g15.edgent.eth" → "0x..."
 *
 * Returns null (instead of throwing) if the name is not registered or
 * resolution fails — callers should treat null as "ENS not available".
 */
export async function resolveENS(name: string): Promise<string | null> {
    try {
        const address = await getEnsAddress(ensClient, { name });
        return address ?? null;
    } catch (err: any) {
        console.warn(`[ens] resolveENS(${name}) failed:`, err.message);
        return null;
    }
}

/**
 * Reverse-looks up an ENS name for a given wallet address.
 * e.g. "0x..." → "dell-g15.edgent.eth"
 *
 * Returns null if no reverse record is set or lookup fails.
 */
export async function lookupENS(address: string): Promise<string | null> {
    try {
        const name = await getEnsName(ensClient, { address: address as `0x${string}` });
        return name ?? null;
    } catch (err: any) {
        console.warn(`[ens] lookupENS(${address}) failed:`, err.message);
        return null;
    }
}
