import { ENV } from './config/env.config';
import { spawnAXL, AXLClient } from './core/axl';
import { getResources } from './core/resources';
import express from 'express';

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

                // Empty router for now
                switch (data.type) {
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
