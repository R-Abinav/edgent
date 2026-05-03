import { ENV } from '../config/env.config';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface KeeperHubResult {
    executionId: string;
    txHash: string;
    txLink: string;
}

// ── Release function ABI — only what KeeperHub needs to encode the call ───────

const RELEASE_ABI = [
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
];

// ── Helpers ───────────────────────────────────────────────────────────────────

const BASE_URL = ENV.KEEPERHUB_BASE_URL || 'https://app.keeperhub.com/api';

function authHeaders() {
    return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ENV.KEEPERHUB_API_KEY}`,
    };
}

/**
 * Converts a snarkjs decimal bigint public signal to a 32-byte hex string.
 * snarkjs returns publicSignals as decimal strings — e.g. "12345678..."
 */
function toBytes32Hex(decimalOrHex: string): string {
    if (decimalOrHex.startsWith('0x')) {
        return '0x' + decimalOrHex.slice(2).padStart(64, '0');
    }
    return '0x' + BigInt(decimalOrHex).toString(16).padStart(64, '0');
}

// ── Exported functions ────────────────────────────────────────────────────────

/**
 * Calls KeeperHub Direct Execution API to trigger EdgentEscrow.release() onchain.
 * KeeperHub's managed wallet (set as `operator` in the contract) signs and submits the tx.
 *
 * Called by requester after ZK proof verification passes.
 *
 * @param jobId       Hex string — same jobId used in stake()
 * @param outputHash  Poseidon commitment — decimal or hex string from zkProof.publicSignals[0]
 * @returns           { executionId, txHash, txLink }
 */
export async function notifyKeeperHub(
    jobId: string,
    outputHash: string
): Promise<KeeperHubResult> {
    if (!ENV.KEEPERHUB_API_KEY) {
        throw new Error('[payment] KEEPERHUB_API_KEY is not set in .env');
    }
    if (!ENV.ESCROW_CONTRACT_ADDRESS) {
        throw new Error('[payment] ESCROW_CONTRACT_ADDRESS is not set in .env');
    }

    const outputHashHex = toBytes32Hex(outputHash);

    const body = {
        contractAddress: ENV.ESCROW_CONTRACT_ADDRESS,
        network: 'base-sepolia',
        functionName: 'release',
        functionArgs: JSON.stringify([jobId, outputHashHex]),
        abi: JSON.stringify(RELEASE_ABI),
    };

    console.log(`[payment] Calling KeeperHub to release escrow for job ${jobId}...`);

    const response = await fetch(`${BASE_URL}/execute/contract-call`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`[payment] KeeperHub POST failed ${response.status}: ${text}`);
    }

    const data = await response.json() as { executionId: string; status: string };
    console.log(`[payment] KeeperHub executionId: ${data.executionId}  status: ${data.status}`);

    // Poll once to get txHash — write calls are synchronous so it should be ready
    const result = await pollExecutionStatus(data.executionId);
    return result;
}

/**
 * Polls KeeperHub for the final status of an execution.
 * Retries every 3 seconds until status is "completed" or "failed".
 * Times out after 2 minutes.
 *
 * @param executionId  The executionId returned by KeeperHub on POST
 * @returns            { executionId, txHash, txLink }
 */
export async function pollExecutionStatus(executionId: string): Promise<KeeperHubResult> {
    const POLL_INTERVAL_MS = 3000;
    const TIMEOUT_MS = 120_000; // 2 minutes
    const started = Date.now();

    console.log(`[payment] Polling KeeperHub status for ${executionId}...`);

    while (true) {
        const elapsed = Date.now() - started;
        if (elapsed > TIMEOUT_MS) {
            throw new Error(`[payment] KeeperHub polling timed out after 2 minutes for ${executionId}`);
        }

        const response = await fetch(`${BASE_URL}/execute/${executionId}/status`, {
            headers: authHeaders(),
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`[payment] KeeperHub status check failed ${response.status}: ${text}`);
        }

        const data = await response.json() as {
            executionId: string;
            status: string;
            transactionHash?: string;
            transactionLink?: string;
        };

        console.log(`[payment] KeeperHub status: ${data.status}`);

        if (data.status === 'completed') {
            const txHash = data.transactionHash ?? '';
            const txLink = data.transactionLink ?? '';
            console.log(`[payment] KeeperHub completed. txHash: ${txHash}`);
            console.log(`[payment] Explorer: ${txLink}`);
            return { executionId, txHash, txLink };
        }

        if (data.status === 'failed') {
            throw new Error(`[payment] KeeperHub execution failed for ${executionId}`);
        }

        // Still pending — wait and retry
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }
}
