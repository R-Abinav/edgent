import { generateZKProof, verifyZKProof } from '../core/integrity';

async function main() {
  const proof = await generateZKProof(
    "hello from the provider",
    123456789n,
    987654321n
  );

  console.log('Proof generated:', proof.publicSignals);

  const valid = await verifyZKProof(proof);
  console.log('Proof valid:', valid);
}

main().catch(console.error);
