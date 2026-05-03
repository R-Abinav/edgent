import { expect } from "chai";
import { viem } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { keccak256, toHex, parseUnits, getAddress } from "viem";

describe("EdgentEscrow", function () {
  let escrow: any;
  let mockUsdc: any;
  let publicClient: any;
  let owner: any;
  let requester: any;
  let provider: any;
  let other: any;

  const jobId = keccak256(toHex("job1"));
  const jobId2 = keccak256(toHex("job2"));
  const outputHash = keccak256(toHex("output1"));
  // USDC has 6 decimals — stake 10 USDC
  const stakeAmount = parseUnits("10", 6);

  beforeEach(async function () {
    publicClient = await viem.getPublicClient();
    [owner, requester, provider, other] = await viem.getWalletClients();

    // Deploy MockUSDC
    mockUsdc = await viem.deployContract("MockUSDC", []);

    // Deploy EdgentEscrow with owner as operator and MockUSDC address
    escrow = await viem.deployContract("EdgentEscrow", [
      owner.account.address,
      mockUsdc.address,
    ]);

    // Mint USDC to requester and approve escrow
    await mockUsdc.write.mint([requester.account.address, parseUnits("1000", 6)], {
      account: owner.account,
    });
    await mockUsdc.write.approve([escrow.address, parseUnits("1000", 6)], {
      account: requester.account,
    });
  });

  // ── Helper: stake for a given job ─────────────────────────────────────────────
  async function doStake(jId = jobId) {
    const hash = await escrow.write.stake([jId, provider.account.address, stakeAmount], {
      account: requester.account,
    });
    await publicClient.waitForTransactionReceipt({ hash });
  }

  describe("Core flow", function () {
    it("1. Stake succeeds with valid USDC amount", async function () {
      await doStake();

      const stakeData = await escrow.read.getStake([jobId]);
      expect(getAddress(stakeData[0])).to.equal(getAddress(requester.account.address));
      expect(getAddress(stakeData[1])).to.equal(getAddress(provider.account.address));
      expect(stakeData[2]).to.equal(stakeAmount);
      expect(stakeData[3]).to.be.false;
    });

    it("2. Release succeeds when called by requester, USDC transfers to provider", async function () {
      await doStake();

      const hash = await escrow.write.release([jobId, outputHash], {
        account: requester.account,
      });
      await publicClient.waitForTransactionReceipt({ hash });

      const stakeData = await escrow.read.getStake([jobId]);
      expect(stakeData[3]).to.be.true;
    });

    it("3. Full happy path — stake → release → provider USDC balance increased", async function () {
      const initialBalance = await mockUsdc.read.balanceOf([provider.account.address]);

      await doStake();
      await escrow.write.release([jobId, outputHash], { account: requester.account });

      const finalBalance = await mockUsdc.read.balanceOf([provider.account.address]);
      expect(finalBalance - initialBalance).to.equal(stakeAmount);
    });
  });

  describe("Stake guards", function () {
    it("4. Stake reverts if amount == 0", async function () {
      await expect(
        escrow.write.stake([jobId, provider.account.address, 0n], {
          account: requester.account,
        })
      ).to.be.rejectedWith("Must stake some USDC");
    });

    it("5. Stake reverts if same jobId used twice", async function () {
      await doStake();

      await expect(
        escrow.write.stake([jobId, provider.account.address, stakeAmount], {
          account: requester.account,
        })
      ).to.be.rejectedWith("Job ID already exists");
    });

    it("6. Stake reverts if providerAddress is zero address", async function () {
      await expect(
        escrow.write.stake([jobId, "0x0000000000000000000000000000000000000000", stakeAmount], {
          account: requester.account,
        })
      ).to.be.rejectedWith("Provider cannot be zero address");
    });
  });

  describe("Release guards", function () {
    beforeEach(async function () {
      await doStake();
    });

    it("7. Release reverts if called by anyone other than requester or operator", async function () {
      await expect(
        escrow.write.release([jobId, outputHash], { account: provider.account })
      ).to.be.rejectedWith("Not authorized");

      await expect(
        escrow.write.release([jobId, outputHash], { account: other.account })
      ).to.be.rejectedWith("Not authorized");
    });

    it("7b. Release succeeds when called by operator", async function () {
      const hash = await escrow.write.release([jobId, outputHash], {
        account: owner.account,
      });
      await publicClient.waitForTransactionReceipt({ hash });

      const stakeData = await escrow.read.getStake([jobId]);
      expect(stakeData[3]).to.be.true;
    });

    it("8. Release reverts if already released", async function () {
      await escrow.write.release([jobId, outputHash], { account: requester.account });

      await expect(
        escrow.write.release([jobId, outputHash], { account: requester.account })
      ).to.be.rejectedWith("Already released");
    });

    it("9. Release reverts if jobId doesn't exist", async function () {
      await expect(
        escrow.write.release([jobId2, outputHash], { account: requester.account })
      ).to.be.rejectedWith("Not authorized");
    });
  });

  describe("Timeout — claimTimeout", function () {
    beforeEach(async function () {
      await doStake();
    });

    it("10. claimTimeout reverts before timeout period", async function () {
      await expect(
        escrow.write.claimTimeout([jobId], { account: provider.account })
      ).to.be.rejectedWith("Timeout not reached");
    });

    it("11. claimTimeout succeeds after timeout, USDC goes to provider", async function () {
      await time.increase(3600);

      const initialBalance = await mockUsdc.read.balanceOf([provider.account.address]);

      const hash = await escrow.write.claimTimeout([jobId], { account: provider.account });
      await publicClient.waitForTransactionReceipt({ hash });

      const finalBalance = await mockUsdc.read.balanceOf([provider.account.address]);
      expect(finalBalance - initialBalance).to.equal(stakeAmount);

      const stakeData = await escrow.read.getStake([jobId]);
      expect(stakeData[3]).to.be.true;
    });

    it("12. claimTimeout reverts if called by non-provider", async function () {
      await time.increase(3600);

      await expect(
        escrow.write.claimTimeout([jobId], { account: requester.account })
      ).to.be.rejectedWith("Only provider can claim timeout");

      await expect(
        escrow.write.claimTimeout([jobId], { account: other.account })
      ).to.be.rejectedWith("Only provider can claim timeout");
    });

    it("13. claimTimeout reverts if already released", async function () {
      await escrow.write.release([jobId, outputHash], { account: requester.account });
      await time.increase(3600);

      await expect(
        escrow.write.claimTimeout([jobId], { account: provider.account })
      ).to.be.rejectedWith("Already released");
    });
  });

  describe("Refund", function () {
    beforeEach(async function () {
      await doStake();
    });

    it("14. refund reverts before timeout period", async function () {
      await expect(
        escrow.write.refund([jobId], { account: requester.account })
      ).to.be.rejectedWith("Too early");
    });

    it("15. refund succeeds after timeout, USDC returns to requester", async function () {
      await time.increase(3600);

      const initialBalance = await mockUsdc.read.balanceOf([requester.account.address]);

      const hash = await escrow.write.refund([jobId], { account: requester.account });
      await publicClient.waitForTransactionReceipt({ hash });

      const finalBalance = await mockUsdc.read.balanceOf([requester.account.address]);
      expect(finalBalance - initialBalance).to.equal(stakeAmount);

      const stakeData = await escrow.read.getStake([jobId]);
      expect(stakeData[3]).to.be.true;
    });

    it("16. refund reverts if called by non-requester", async function () {
      await time.increase(3600);

      await expect(
        escrow.write.refund([jobId], { account: provider.account })
      ).to.be.rejectedWith("Only requester");

      await expect(
        escrow.write.refund([jobId], { account: other.account })
      ).to.be.rejectedWith("Only requester");
    });

    it("17. refund reverts if already released", async function () {
      await escrow.write.release([jobId, outputHash], { account: requester.account });
      await time.increase(3600);

      await expect(
        escrow.write.refund([jobId], { account: requester.account })
      ).to.be.rejectedWith("Already released");
    });
  });

  describe("Edge cases", function () {
    it("18. getStake returns correct data after staking", async function () {
      await doStake();

      const stakeData = await escrow.read.getStake([jobId]);
      expect(getAddress(stakeData[0])).to.equal(getAddress(requester.account.address));
      expect(getAddress(stakeData[1])).to.equal(getAddress(provider.account.address));
      expect(stakeData[2]).to.equal(stakeAmount);
      expect(stakeData[3]).to.be.false;
    });

    it("19. getStake returns zero address for nonexistent jobId", async function () {
      const stakeData = await escrow.read.getStake([jobId2]);
      expect(stakeData[0]).to.equal("0x0000000000000000000000000000000000000000");
      expect(stakeData[1]).to.equal("0x0000000000000000000000000000000000000000");
      expect(stakeData[2]).to.equal(0n);
      expect(stakeData[3]).to.be.false;
    });

    it("20. Both claimTimeout and refund cannot both succeed on same jobId", async function () {
      await doStake();
      await time.increase(3600);

      await escrow.write.claimTimeout([jobId], { account: provider.account });

      await expect(
        escrow.write.refund([jobId], { account: requester.account })
      ).to.be.rejectedWith("Already released");
    });
  });
});
