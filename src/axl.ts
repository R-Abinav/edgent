import { spawn } from 'node:child_process';

//the translator
export class AXLClient {
    private apiPort: number

    constructor(apiPort: number) {

    }


}

//the spawner or manager
export function spawnAXL(configPath: string, apiPort: number): () => void {
    const child = spawn('./axl-bin/node', ['-config', configPath]);
}