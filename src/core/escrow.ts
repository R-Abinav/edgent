import { parseUnits } from 'viem';
import { ENV } from '../config/env.config';
import { getWalletClient, getPublicClient, getWalletAddress } from './wallet';

// ── Contract config ───────────────────────────────────────────────────────────

const CONTRACT_ADDRESS = ENV.ESCROW_CONTRACT_ADDRESS as `0x${string}`;
const USDC_ADDRESS = ENV.USDC_CONTRACT_ADDRESS as `0x${string}`;

// Minimal USDC ABI — only approve, called before stake().
const USDC_ABI = [{
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
        { name: 'spender', type: 'address' },
        { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
}] as const;

// Minimal escrow ABI — only the four functions we actually call.
const ESCROW_ABI = [
    {
        name: 'stake',
        type: 'function',
        stateMutability: 'nonpayable',
        inputs: [
            { name: 'jobId', type: 'bytes32' },
            { name: 'providerAddress', type: 'address' },
            { name: 'amount', type: 'uint256' },
        ],
        outputs: [],
    },
    {
        name: 'release',
        type: 'function',
        stateMutability: 'nonpayable',
        inputs: [
            { name: 'jobId', type: 'bytes32' },
            { name: 'outputHash', type: 'bytes32' },
        ],
        outputs: [],
    },
    {
        name: 'getStake',
        type: 'function',
        stateMutability: 'view',
        inputs: [
            { name: 'jobId', type: 'bytes32' },
        ],
        outputs: [
            { name: 'requester', type: 'address' },
            { name: 'provider', type: 'address' },
            { name: 'amount', type: 'uint256' },
            { name: 'released', type: 'bool' },
        ],
    },
    {
        name: 'claimTimeout',
        type: 'function',
        stateMutability: 'nonpayable',
        inputs: [
            { name: 'jobId', type: 'bytes32' },
        ],
        outputs: [],
    },
] as const;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StakeInfo {
    requester: string;
    provider: string;
    amount: bigint;
    released: boolean;
}

// ── Exported functions ────────────────────────────────────────────────────────

/**
 * Approves + stakes USDC into the EdgentEscrow contract for a given job.
 * Called by the requester (Jetson) before sending task_request.
 * Step 1: approve escrow to spend USDC.
 * Step 2: call stake() — transferFrom moves USDC into escrow.
 *
 * @param jobId           Hex string — "0x" + 32-byte UUID with dashes stripped
 * @param providerAddress Wallet address of the provider (Dell)
 * @param amountUsdc      USDC amount as a decimal string e.g. "10" (= 10 USDC)
 * @returns               Stake transaction hash
 */
export async function stakeForJob(
    jobId: string,
    providerAddress: string,
    amountUsdc: string
): Promise<`0x${string}`> {
    if (!CONTRACT_ADDRESS || CONTRACT_ADDRESS === '0x') {
        throw new Error('[escrow] ESCROW_CONTRACT_ADDRESS is not set in .env');
    }
    if (!USDC_ADDRESS || USDC_ADDRESS === '0x') {
        throw new Error('[escrow] USDC_CONTRACT_ADDRESS is not set in .env');
    }

    const walletClient = getWalletClient();
    const publicClient = getPublicClient();
    const account = getWalletAddress() as `0x${string}`;
    const value = parseUnits(amountUsdc, 6); // USDC has 6 decimals

    console.log(`[escrow] Approving ${amountUsdc} USDC for escrow...`);

    // Step 1: approve escrow contract to pull USDC
    const approveTx = await walletClient.writeContract({
        address: USDC_ADDRESS,
        abi: USDC_ABI,
        functionName: 'approve',
        args: [CONTRACT_ADDRESS, value],
        account,
    });
    await publicClient.waitForTransactionReceipt({ hash: approveTx });
    console.log(`[escrow] USDC approval confirmed.`);

    console.log(`[escrow] Staking ${amountUsdc} USDC for job ${jobId}...`);

    // Step 2: stake — contract pulls USDC via transferFrom
    const txHash = await walletClient.writeContract({
        address: CONTRACT_ADDRESS,
        abi: ESCROW_ABI,
        functionName: 'stake',
        args: [jobId as `0x${string}`, providerAddress as `0x${string}`, value],
        account,
    });

    console.log(`[escrow] Stake tx sent: ${txHash}`);
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    console.log(`[escrow] Stake confirmed onchain.`);

    return txHash;
}

/**
 * Reads stake data from the contract.
 * Called by the provider (Dell) after receiving task_request — confirms funds
 * are locked before starting inference.
 *
 * @param jobId  Hex string matching the one in the task_request message
 * @returns      StakeInfo — { requester, provider, amount, released }
 */
export async function verifyStake(jobId: string): Promise<StakeInfo> {
    const publicClient = getPublicClient();

    const result = await publicClient.readContract({
        address: CONTRACT_ADDRESS,
        abi: ESCROW_ABI,
        functionName: 'getStake',
        args: [jobId as `0x${string}`],
    }) as { requester: string; provider: string; amount: bigint; released: boolean };

    const { requester, provider, amount, released } = result;

    if (requester === '0x0000000000000000000000000000000000000000') {
        throw new Error(`[escrow] No stake found for jobId ${jobId}`);
    }

    return { requester, provider, amount, released };
}

/**
 * Releases USDC from escrow to the provider.
 * Called by the requester after ZK proof verification passes.
 * outputHash is the Poseidon commitment from ZK proof public signals.
 *
 * @param jobId       Hex string matching the staked job
 * @param outputHash  Poseidon commitment string from zkProof.publicSignals[0]
 * @returns           Transaction hash
 */
export async function releasePayment(
    jobId: string,
    outputHash: string
): Promise<`0x${string}`> {
    const walletClient = getWalletClient();
    const account = getWalletAddress() as `0x${string}`;

    // outputHash from snarkjs is a decimal bigint string — convert to 32-byte hex
    const outputHashHex = ('0x' + BigInt(outputHash).toString(16).padStart(64, '0')) as `0x${string}`;

    console.log(`[escrow] Releasing payment for job ${jobId}...`);

    const txHash = await walletClient.writeContract({
        address: CONTRACT_ADDRESS,
        abi: ESCROW_ABI,
        functionName: 'release',
        args: [jobId as `0x${string}`, outputHashHex],
        account,
    });

    console.log(`[escrow] Release tx sent: ${txHash}`);

    const publicClient = getPublicClient();
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    console.log(`[escrow] Release confirmed onchain.`);

    return txHash;
}
