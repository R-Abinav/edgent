import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const EdgentEscrowModule = buildModule("EdgentEscrowModule", (m) => {
  const operator = m.getParameter("operator", "0x0000000000000000000000000000000000000000");
  const usdc = m.getParameter("usdc", "0x0000000000000000000000000000000000000000");

  const escrow = m.contract("EdgentEscrow", [operator, usdc]);

  return { escrow };
});

export default EdgentEscrowModule;
