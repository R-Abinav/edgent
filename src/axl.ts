import { spawn } from 'child_process';

//the translator
export class AXLClient {
    private apiPort: number

    constructor(apiPort: number) {
        this.apiPort = apiPort;
    }

    async waitReady(timeoutMs = 30000): Promise<void> {
        const start = Date.now();

        while (Date.now() - start < timeoutMs){
            try{
                const url = `http://localhost:${this.apiPort}/topology`
                const response = await fetch(url);

                if (response.status == 200){
                    //ok respomse
                    return;
                }
            }catch(err){
                //ignore and retry!
            }

            //wait 500ms before retrying
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        throw new Error("AXL waitReady timeout: Failed to connect to AXL API!!");
    }

    async getTopology(): Promise<{ ourPublicKey: string; peers: Array<{ publicKey: string; up: boolean }> }> {
        const url = `http://localhost:${this.apiPort}/topology`
        const response = await fetch(url);
        if(!response.ok){
            throw new Error(`Failed to get topology!: ${response.status}`);
        }

        const data = await response.json();

        //map snake_case to camelCase
        return {
            ourPublicKey: data.our_public_key,
            peers: (data.peers || []).map((p: any) => ({
                publicKey: p.public_key,
                up: p.up
            }))
        }
    }

    async getPeers(): Promise<string[]>{
        const topology = await this.getTopology();

        return topology.peers.filter(p => p.up).map(p => p.publicKey);
    }

    async send(peerId: string, message: unknown): Promise<void> {
        const sendUrl = `http://localhost:${this.apiPort}/send`;
        const response = await fetch(sendUrl, {
            method: 'POST',
            headers: {
                'X-Destination-Peer-Id': peerId,
                'Content-type': 'application/octet-stream'
            },
            body: Buffer.from(JSON.stringify(message))
        });

        if(!response.ok){
            throw new Error(`Failed to send message!!: ${response.status} ${response.statusText}`);
        }
    }

    async recv(): Promise<{ fromPeerId: string; data: unknown } | null>{
        const recvUrl = `http://localhost:${this.apiPort}/recv`;
        const response = await fetch(recvUrl);

        //if 204 -> No content, there are no msgs
        if(response.status == 204){
            return null;
        }

        if(response.status == 200){
            const fromPeerId = response.headers.get('x-from-peer-id');

            if(!fromPeerId){
                throw new Error('Missing x-from-peer-id header in /recv response');
            }

            const text = await response.text();
            let data: unknown;
            try{
                data = JSON.parse(text);
            }catch(err){
                data = text; //fallback if its somehow not JSON!
            }

            return { fromPeerId, data };
        }

        throw new Error(`Unexpected status from /recv: ${response.status}`);
    }

}

//the spawner or manager
export function spawnAXL(configPath: string, apiPort: number): () => void {
    const child = spawn('./axl-bin/node', ['-config', configPath]);

    //log the data
    child.stdout.on("data", (data: any) => {
        //convert the buffer to string and remove the trailing newlines to avoid double spacing
        console.log(`[axl] ${data.toString().trim()}`);
    });

    child.stderr.on("data", (data: any) => {
        console.error(`[axl] ${data.toString().trim()}`);
    });

    child.on('error', (err: any) => {
        console.error(`[axl] Error spawning process: `, err);
    });

    //returning the cleanup func
    return () => {
        console.log("[edgent] shutting down the AXL node...");
        child.kill();
    }
}