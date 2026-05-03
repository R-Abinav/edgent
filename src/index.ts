import { ENV } from './config/env.config';
import { spawnAXL, AXLClient } from './core/axl';
import { getResources } from './core/resources';
import express from 'express';
import path from 'path';

import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { runInference } from './core/executor';
import { generateZKProof, verifyZKProof, axlKeyToBigInts } from './core/integrity';
import { notifyKeeperHub } from './core/payment';
import { stakeForJob, verifyStake } from './core/escrow';

async function main() {
    //read role from CLI arg
    const args = process.argv.slice(2);
    const roleArg = args.find(a => a.startsWith('--role='));
    const role = roleArg ? roleArg.split('=')[1] : ENV.ROLE;

    console.log(`[edgent] Starting Edgent daemon in '${role}' role...`);

    //pick the right AXL config file and port based on role
    //using node-config-a (port 9002) for provider, node-config-b (port 9012) for requester
    const configPath = role === 'provider' ? './node-config-a.json' : './node-config-b.json';
    const apiPort = role === 'provider' ? 9002 : 9012;

    //using 3001 for provider, 3002 for requester to avoid port conflicts during local testing
    const daemonPort = role === 'provider' ? 3001 : 3002;

    console.log(`[edgent] Using config: ${configPath}`);
    console.log(`[edgent] AXL API Port: ${apiPort}`);

    //spawn AXL
    const cleanupAXL = spawnAXL(configPath, apiPort);

    //create AXLClient
    const client = new AXLClient(apiPort);

    const pendingTasks = new Map<string, {
        resolve: (result: any) => void;
        reject: (err: Error) => void;
    }>();

    // Temporarily holds task output between task_result and payment_request messages
    const pendingOutputs = new Map<string, string>(); // requestId → output

    // Rolling log of last 10 completed/failed jobs — served by /jobs endpoint
    const recentJobs: Array<{
        jobId: string;
        requestId: string;
        status: 'completed' | 'failed';
        durationMs: number;
        txHash: string;
        txLink: string;
        timestamp: number;
    }> = [];

    const routerEvents = new EventEmitter();

    //call waitReady() and log
    console.log('[edgent] Waiting for AXL mesh to be ready...');
    await client.waitReady();
    console.log('[edgent] AXL is ready!');

    //log own public key
    const topology = await client.getTopology();
    console.log(`[edgent] Node Public Key: ${topology.ourPublicKey}`);

    //one-time startup advertisement
    const resources = await getResources();
    const peers = await client.getPeers();
    if (peers.length > 0) {
        try {
            for (const peerId of peers) {
                await client.send(peerId, {
                    type: 'resource_ad',
                    nodeId: topology.ourPublicKey,
                    timestamp: Date.now(),
                    resources
                });
            }
            console.log(`[edgent] Sent resource_ad to ${peers.length} peer(s)`);
        } catch (err) {
            console.warn('[edgent] Could not send resource_ad (expected on localhost):', (err as Error).message);
        }
    }

    //loop 1: Message poll (every 500ms)
    const pollInterval = setInterval(async () => {
        try {
            const msg = await client.recv();
            if (msg) {
                const data = msg.data as any;
                console.log(`[edgent] Received message from ${msg.fromPeerId}: ${data.type || 'unknown'}`);

                // Message router
                switch (data.type) {
                    case 'resource_request': {
                        console.log(`[edgent] Received resource_request from ${msg.fromPeerId}`);
                        const resourcesInfo = await getResources();
                        await client.send(msg.fromPeerId, {
                            type: 'resource_ad',
                            nodeId: topology.ourPublicKey,
                            ensName: ENV.ENS_NAME || 'node.edgent.eth',
                            walletAddress: ENV.WALLET_ADDRESS || '0x0000000000000000000000000000000000000000',
                            timestamp: Date.now(),
                            resources: resourcesInfo,
                            pricePerJob: { amount: ENV.PRICE_PER_JOB_USDC || '0.01', currency: 'USDC', chain: ENV.CHAIN || 'base-sepolia' }
                        });
                        break;
                    }
                    case 'resource_ad': {
                        console.log(`[edgent] Received resource_ad from ${data.ensName || msg.fromPeerId}`);
                        console.log(`[edgent]   RAM free: ${data.resources.freeRamMB}MB  Models: [${data.resources.availableModels.join(', ')}]  Price: ${data.pricePerJob?.amount || '0.01'} USDC`);
                        routerEvents.emit('resource_ad', data);
                        break;
                    }
                    case 'task_request': {
                        console.log(`[edgent] Received task_request from ${msg.fromPeerId}`);
                        
                        // Verify stake is live onchain before doing any work
                        try {
                            const stake = await verifyStake(data.jobId);
                            if (stake.released) {
                                console.error(`[edgent] Stake already released for job ${data.jobId} — rejecting`);
                                break;
                            }
                            console.log(`[edgent] Stake verified: ${stake.amount} USDC locked onchain`);
                        } catch (err: any) {
                            console.error(`[edgent] Stake not found for job ${data.jobId}:`, err.message);
                            break;
                        }
                        
                        try {
                            const result = await runInference(data.task.model, data.task.prompt);
                            if (!result) throw new Error("Inference failed");
                            console.log(`[edgent] Inference complete (${result.durationMs}ms, ${result.tokensGenerated || 0} tokens)`);
                            console.log(`[edgent] Generating ZK proof...`);
                            
                            const [pubX, pubY] = axlKeyToBigInts(topology.ourPublicKey);
                            const zkProof = await generateZKProof(result.output, pubX, pubY);
                
                            console.log(`[edgent] Sending task_result + proof...`);
                            await client.send(msg.fromPeerId, {
                                type: 'task_result',
                                requestId: data.requestId,
                                fromNodeId: topology.ourPublicKey,
                                toNodeId: msg.fromPeerId,
                                timestamp: Date.now(),
                                result: {
                                    output: result.output,
                                    tokensGenerated: result.tokensGenerated || 0,
                                    durationMs: result.durationMs
                                },
                                zkProof
                            });

                            // x402: send payment_request after delivering result
                            await client.send(msg.fromPeerId, {
                                type: 'payment_request',
                                jobId: data.jobId,
                                requestId: data.requestId,
                                amount: ENV.PRICE_PER_JOB_USDC,
                                currency: 'USDC',
                                chain: 'base-sepolia',
                                walletAddress: ENV.PROVIDER_WALLET_ADDRESS,
                                outputCommitment: zkProof.publicSignals[0]
                            });
                            console.log(`[edgent] Sent x402 payment_request for job ${data.jobId}`);

                        } catch (err: any) {
                            console.error(`[edgent] Task failed:`, err.message);
                        }
                        break;
                    }
                    case 'task_result': {
                        console.log(`[edgent] Received task_result from ${msg.fromPeerId}`);
                        const isValid = await verifyZKProof(data.zkProof);
                        console.log(`[edgent] Verifying ZK proof... ${isValid ? 'valid' : 'invalid'}`);
                        
                        if (isValid) {
                            // Store output — will be resolved when payment_request arrives
                            pendingOutputs.set(data.requestId, data.result.output);
                            console.log(`[edgent] ZK proof valid. Awaiting x402 payment_request...`);
                        } else {
                            // Reject immediately on bad proof — no payment will follow
                            if (pendingTasks.has(data.requestId)) {
                                pendingTasks.get(data.requestId)!.reject(new Error('Invalid ZK proof'));
                                pendingTasks.delete(data.requestId);
                            }
                        }
                        break;
                    }
                    case 'payment_request': {
                        console.log(`[edgent] Received x402 payment_request from ${msg.fromPeerId}`);
                        console.log(`[edgent] ${data.amount} ${data.currency} → ${data.walletAddress}`);

                        try {
                            const { executionId, txHash, txLink } = await notifyKeeperHub(
                                data.jobId,
                                data.outputCommitment
                            );
                            console.log(`[edgent] KeeperHub executionId: ${executionId}`);
                            console.log(`[edgent] txHash: ${txHash}`);
                            console.log(`[edgent] Explorer: ${txLink}`);

                            // Send payment_confirmed back to provider
                            await client.send(msg.fromPeerId, {
                                type: 'payment_confirmed',
                                requestId: data.requestId,
                                jobId: data.jobId,
                                fromNodeId: topology.ourPublicKey,
                                toNodeId: msg.fromPeerId,
                                executionId,
                                txHash,
                                txLink
                            });

                            // Resolve the pending /delegate promise with the stored output
                            if (pendingTasks.has(data.requestId)) {
                                const output = pendingOutputs.get(data.requestId) ?? '';
                                pendingOutputs.delete(data.requestId);
                                pendingTasks.get(data.requestId)!.resolve({ output, executionId, txHash });
                                pendingTasks.delete(data.requestId);
                            }

                            // Requester side: record the completed job
                            recentJobs.push({
                                jobId: data.jobId,
                                requestId: data.requestId,
                                status: 'completed',
                                durationMs: 0,
                                txHash,
                                txLink,
                                timestamp: Date.now(),
                            });
                            if (recentJobs.length > 50) recentJobs.shift();
                        } catch (err: any) {
                            console.error(`[edgent] Payment failed:`, err.message);
                            if (pendingTasks.has(data.requestId)) {
                                pendingTasks.get(data.requestId)!.reject(err);
                                pendingTasks.delete(data.requestId);
                            }
                        }
                        break;
                    }
                    case 'payment_confirmed': {
                        console.log(`[edgent] Payment confirmed for ${data.requestId} by ${msg.fromPeerId}`);
                        // Provider side: record the completed job
                        recentJobs.push({
                            jobId: data.jobId ?? '',
                            requestId: data.requestId,
                            status: 'completed',
                            durationMs: 0, // provider doesn't know requester-side duration
                            txHash: data.txHash ?? '',
                            txLink: data.txLink ?? '',
                            timestamp: Date.now(),
                        });
                        if (recentJobs.length > 50) recentJobs.shift(); // keep bounded
                        break;
                    }
                    default:
                        // Ignore unhandled types
                        break;
                }
            }
        } catch (err) {
            console.error('[edgent] Error polling messages:', err);
        }
    }, 500);



    //HTTP Server
    const app = express();
    app.use(express.json()); //middleware

    app.post('/delegate', async (req, res) => {
        try {
            const { model, prompt, maxTokens } = req.body;
            const availablePeers = await client.getPeers();
            
            console.log(`[edgent] Broadcasting resource_request to ${availablePeers.length} peer(s)...`);
            if (availablePeers.length === 0) {
                res.status(503).json({ error: 'No peers available' });
                return;
            }

            const requestSentAt = Date.now();
            for (const peer of availablePeers) {
                await client.send(peer, {
                    type: 'resource_request',
                    fromNodeId: topology.ourPublicKey,
                    timestamp: requestSentAt,
                    task: { kind: 'llm_inference', model, promptLength: prompt.length }
                });
            }

            console.log(`[edgent] Waiting for resource_ad...`);
            const targetPeer = await new Promise<string>((resolve, reject) => {
                const timeout = setTimeout(() => {
                    routerEvents.off('resource_ad', handler);
                    reject(new Error('Timeout waiting for resource_ad'));
                }, 5000); // Wait up to 5 seconds for an ad
                
                const handler = (adData: any) => {
                    if (adData.timestamp < requestSentAt) return; // stale, ignore
                    
                    if (!availablePeers.includes(adData.nodeId)) {
                        console.warn('[edgent] resource_ad from unknown peer, ignoring');
                        return;
                    }
                    
                    clearTimeout(timeout);
                    routerEvents.off('resource_ad', handler);
                    resolve(adData.nodeId);
                };
                routerEvents.on('resource_ad', handler);
            });

            const requestId = randomUUID();
            const jobId = '0x' + randomUUID().replace(/-/g, '');

            // Stake USDC in escrow before sending task_request
            await stakeForJob(jobId, targetPeer, ENV.PRICE_PER_JOB_USDC || '0.01');
            console.log(`[edgent] Stake confirmed for job ${jobId}`);

            const resultPromise = new Promise((resolve, reject) => {
                pendingTasks.set(requestId, { resolve, reject });
            });

            // 60s timeout
            setTimeout(() => {
                if (pendingTasks.has(requestId)) {
                    pendingTasks.get(requestId)!.reject(new Error('Task timeout'));
                    pendingTasks.delete(requestId);
                }
            }, 60000);

            await client.send(targetPeer, {
                type: 'task_request',
                requestId,
                fromNodeId: topology.ourPublicKey,
                toNodeId: targetPeer,
                jobId,
                timestamp: Date.now(),
                task: { model, prompt, maxTokens }
            });

            const result = await resultPromise;
            res.json(result);
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });

    app.get('/status', async (req, res) => {
        try {
            const resources = await getResources();
            const peers = await client.getPeers();
            const currentTopology = await client.getTopology();

            res.json({
                nodeId: currentTopology.ourPublicKey,
                role: role,
                resources: resources,
                peers: peers
            });
        } catch (err) {
            res.status(500).json({ error: 'Failed to fetch status' });
        }
    });

    app.get('/jobs', (req, res) => {
        res.json(recentJobs.slice(-10).reverse());
    });

    app.get('/dashboard', (req, res) => {
        res.sendFile(path.join(process.cwd(), 'dashboard/index.html'));
    });

    const server = app.listen(daemonPort, () => {
        console.log(`[edgent] HTTP status server running on port ${daemonPort}`);
    });

    //shutdown handling
    const shutdown = () => {
        console.log('\n[edgent] Shutting down cleanly...');
        clearInterval(pollInterval);
        server.close();
        cleanupAXL(); // kill the Go binary
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch(console.error);
