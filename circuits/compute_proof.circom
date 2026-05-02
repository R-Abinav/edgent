pragma circom 2.0.0;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/bitify.circom";

template ComputeProof(outputBitLen) {
    // ── Public inputs (known to verifier / requester) ──
    signal input outputCommitment;       // Poseidon(output_lo, output_hi)
    signal input walletCommitment;       // Poseidon(providerPubKeyX, providerPubKeyY)

    // ── Private inputs (known only to prover / provider) ──
    signal input outputBits[outputBitLen];
    signal input providerPubKeyX;
    signal input providerPubKeyY;

    // ── Constraint 1: Poseidon(output chunks) === outputCommitment ──
    component b2n_lo = Bits2Num(128);
    component b2n_hi = Bits2Num(128);
    for (var i = 0; i < 128; i++) {
        b2n_lo.in[i] <== outputBits[i];
        b2n_hi.in[i] <== outputBits[i + 128];
    }
    component posOut = Poseidon(2);
    posOut.inputs[0] <== b2n_lo.out;
    posOut.inputs[1] <== b2n_hi.out;
    posOut.out === outputCommitment;

    // ── Constraint 2: Poseidon(pubKeyX, pubKeyY) === walletCommitment ──
    component posWallet = Poseidon(2);
    posWallet.inputs[0] <== providerPubKeyX;
    posWallet.inputs[1] <== providerPubKeyY;
    posWallet.out === walletCommitment;
}

component main {public [outputCommitment, walletCommitment]} = ComputeProof(256);