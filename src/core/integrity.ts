import { createHash } from 'crypto';

export interface IntegrityProof {
  outputHash: string;
  mode: 'hash' | 'zk';
  zkProof?: {
    proof: object;
    publicSignals: string[];
  };
}

export function generateProof(output: string, prompt: string, model: string): IntegrityProof {
  const outputHash = createHash('sha256').update(output).digest('hex');
  
  return {
    outputHash,
    mode: 'hash'
  };
}

export function verifyIntegrity(output: string, proof: IntegrityProof): boolean {
  const recomputedHash = createHash('sha256').update(output).digest('hex');

  if (proof.mode === 'hash') {
    return recomputedHash === proof.outputHash;
  }

  if (proof.mode === 'zk') {
    // future: groth16.verify() slots in here
    return false; // not implemented yet, be explicit
  }

  return false;
}
