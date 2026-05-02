import { groth16 } from 'snarkjs';
import { buildPoseidon } from 'circomlibjs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import vkey from '../../circuits/build/verification_key.json' assert { type: 'json' };

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ZKProof {
  proof: object;
  publicSignals: string[];
}

function stringToBits256(str: string): string[] {
  const bytes = Buffer.from(str).slice(0, 32);
  const padded = Buffer.alloc(32);
  bytes.copy(padded);
  const bits: string[] = [];
  for (const byte of padded) {
    for (let i = 0; i < 8; i++) {
      bits.push(((byte >> i) & 1).toString());
    }
  }
  return bits;
}

const WASM_PATH = path.resolve(__dirname, '../../circuits/build/compute_proof_js/compute_proof.wasm');
const ZKEY_PATH = path.resolve(__dirname, '../../circuits/build/compute_proof_final.zkey');

export async function generateZKProof(
  output: string,
  providerPubKeyX: bigint,
  providerPubKeyY: bigint
): Promise<ZKProof> {
  const poseidon = await buildPoseidon();
  
  const outputBits = stringToBits256(output);
  
  let lo_128bits = 0n;
  for (let i = 0; i < 128; i++) {
    if (outputBits[i] === '1') {
      lo_128bits += (1n << BigInt(i));
    }
  }
  
  let hi_128bits = 0n;
  for (let i = 0; i < 128; i++) {
    if (outputBits[i + 128] === '1') {
      hi_128bits += (1n << BigInt(i));
    }
  }

  const outHash = poseidon([lo_128bits, hi_128bits]);
  const outputCommitment = poseidon.F.toString(outHash);
  
  const walletHash = poseidon([providerPubKeyX, providerPubKeyY]);
  const walletCommitment = poseidon.F.toString(walletHash);

  const input = {
    outputCommitment,
    walletCommitment,
    outputBits,
    providerPubKeyX: providerPubKeyX.toString(),
    providerPubKeyY: providerPubKeyY.toString()
  };

  const { proof, publicSignals } = await groth16.fullProve(input, WASM_PATH, ZKEY_PATH);

  return { proof, publicSignals };
}

export async function verifyZKProof(zkProof: ZKProof): Promise<boolean> {
  return await groth16.verify(vkey, zkProof.publicSignals, zkProof.proof);
}
