import { expect } from "chai";
import { viem } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { keccak256, toHex, parseEther, getAddress } from "viem";

describe("EdgentEscrow", function () {
  let escrow: any;
  let publicClient: any;
  let owner: any;
  let requester: any;
  let provider: any;
  let other: any;

  const jobId = keccak256(toHex("job1"));
  const jobId2 = keccak256(toHex("job2"));
  const outputHash = keccak256(toHex("output1"));
  const stakeAmount = parseEther("0.1");

  beforeEach(async function () {
    publicClient = await viem.getPublicClient();
    [owner, requester, provider, other] = await viem.getWalletClients();
    // Use owner.account.address as operator for tests
    escrow = await viem.deployContract("EdgentEscrow", [owner.account.address]);
  });

  describe("Core flow", function () {
    it("1. Stake succeeds with valid ETH amount", async function () {
      const hash = await escrow.write.stake([jobId, provider.account.address], {
        value: stakeAmount,
        account: requester.account,
      });
      await publicClient.waitForTransactionReceipt({ hash });

      const stakeData = await escrow.read.getStake([jobId]);
      expect(getAddress(stakeData[0])).to.equal(getAddress(requester.account.address));
      expect(getAddress(stakeData[1])).to.equal(getAddress(provider.account.address));
      expect(stakeData[2]).to.equal(stakeAmount);
      expect(stakeData[3]).to.be.false;
    });

    it("2. Release succeeds when called by requester, ETH transfers to provider", async function () {
      await escrow.write.stake([jobId, provider.account.address], {
        value: stakeAmount,
        account: requester.account,
      });

      const hash = await escrow.write.release([jobId, outputHash], {
        account: requester.account,
      });
      await publicClient.waitForTransactionReceipt({ hash });

      const stakeData = await escrow.read.getStake([jobId]);
      expect(stakeData[3]).to.be.true;
    });

    it("3. Full happy path — stake → release → provider balance increased by correct amount", async function () {
      const initialProviderBalance = await publicClient.getBalance({ address: provider.account.address });

      await escrow.write.stake([jobId, provider.account.address], {
        value: stakeAmount,
        account: requester.account,
      });
      await escrow.write.release([jobId, outputHash], {
        account: requester.account,
      });

      const finalProviderBalance = await publicClient.getBalance({ address: provider.account.address });
      expect(finalProviderBalance - initialProviderBalance).to.equal(stakeAmount);
    });
  });

  describe("Stake guards", function () {
    it("4. Stake reverts if msg.value == 0", async function () {
      await expect(
        escrow.write.stake([jobId, provider.account.address], {
          value: 0n,
          account: requester.account,
        })
      ).to.be.rejectedWith("Must stake some ETH");
    });

    it("5. Stake reverts if same jobId used twice", async function () {
      await escrow.write.stake([jobId, provider.account.address], {
        value: stakeAmount,
        account: requester.account,
      });

      await expect(
        escrow.write.stake([jobId, provider.account.address], {
          value: stakeAmount,
          account: requester.account,
        })
      ).to.be.rejectedWith("Job ID already exists");
    });

    it("6. Stake reverts if providerAddress is zero address", async function () {
      await expect(
        escrow.write.stake([jobId, "0x0000000000000000000000000000000000000000"], {
          value: stakeAmount,
          account: requester.account,
        })
      ).to.be.rejectedWith("Provider cannot be zero address");
    });
  });

  describe("Release guards", function () {
    beforeEach(async function () {
      await escrow.write.stake([jobId, provider.account.address], {
        value: stakeAmount,
        account: requester.account,
      });
    });

    it("7. Release reverts if called by anyone other than requester or operator", async function () {
      await expect(
        escrow.write.release([jobId, outputHash], {
          account: provider.account,
        })
      ).to.be.rejectedWith("Not authorized");

      await expect(
        escrow.write.release([jobId, outputHash], {
          account: other.account,
        })
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
      await escrow.write.release([jobId, outputHash], {
        account: requester.account,
      });

      await expect(
        escrow.write.release([jobId, outputHash], {
          account: requester.account,
        })
      ).to.be.rejectedWith("Already released");
    });

    it("9. Release reverts if jobId doesn't exist", async function () {
      await expect(
        escrow.write.release([jobId2, outputHash], {
          account: requester.account,
        })
      ).to.be.rejectedWith("Not authorized");
    });
  });

  describe("Timeout — claimTimeout", function () {
    beforeEach(async function () {
      await escrow.write.stake([jobId, provider.account.address], {
        value: stakeAmount,
        account: requester.account,
      });
    });

    it("10. claimTimeout reverts before timeout period", async function () {
      await expect(
        escrow.write.claimTimeout([jobId], {
          account: provider.account,
        })
      ).to.be.rejectedWith("Timeout not reached");
    });

    it("11. claimTimeout succeeds after timeout, ETH goes to provider", async function () {
      await time.increase(3600); // 1 hour

      const initialProviderBalance = await publicClient.getBalance({ address: provider.account.address });

      const hash = await escrow.write.claimTimeout([jobId], {
        account: provider.account,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      const gasCost = receipt.gasUsed * receipt.effectiveGasPrice;

      const finalProviderBalance = await publicClient.getBalance({ address: provider.account.address });
      expect(finalProviderBalance + gasCost - initialProviderBalance).to.equal(stakeAmount);

      const stakeData = await escrow.read.getStake([jobId]);
      expect(stakeData[3]).to.be.true;
    });

    it("12. claimTimeout reverts if called by non-provider", async function () {
      await time.increase(3600);

      await expect(
        escrow.write.claimTimeout([jobId], {
          account: requester.account,
        })
      ).to.be.rejectedWith("Only provider can claim timeout");

      await expect(
        escrow.write.claimTimeout([jobId], {
          account: other.account,
        })
      ).to.be.rejectedWith("Only provider can claim timeout");
    });

    it("13. claimTimeout reverts if already released", async function () {
      await escrow.write.release([jobId, outputHash], {
        account: requester.account,
      });
      await time.increase(3600);

      await expect(
        escrow.write.claimTimeout([jobId], {
          account: provider.account,
        })
      ).to.be.rejectedWith("Already released");
    });
  });

  describe("Refund", function () {
    beforeEach(async function () {
      await escrow.write.stake([jobId, provider.account.address], {
        value: stakeAmount,
        account: requester.account,
      });
    });

    it("14. refund reverts before timeout period", async function () {
      await expect(
        escrow.write.refund([jobId], {
          account: requester.account,
        })
      ).to.be.rejectedWith("Too early");
    });

    it("15. refund succeeds after timeout, ETH returns to requester", async function () {
      await time.increase(3600);

      const initialRequesterBalance = await publicClient.getBalance({ address: requester.account.address });

      const hash = await escrow.write.refund([jobId], {
        account: requester.account,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      const gasCost = receipt.gasUsed * receipt.effectiveGasPrice;

      const finalRequesterBalance = await publicClient.getBalance({ address: requester.account.address });
      expect(finalRequesterBalance + gasCost - initialRequesterBalance).to.equal(stakeAmount);

      const stakeData = await escrow.read.getStake([jobId]);
      expect(stakeData[3]).to.be.true;
    });

    it("16. refund reverts if called by non-requester", async function () {
      await time.increase(3600);

      await expect(
        escrow.write.refund([jobId], {
          account: provider.account,
        })
      ).to.be.rejectedWith("Only requester");

      await expect(
        escrow.write.refund([jobId], {
          account: other.account,
        })
      ).to.be.rejectedWith("Only requester");
    });

    it("17. refund reverts if already released", async function () {
      await escrow.write.release([jobId, outputHash], {
        account: requester.account,
      });
      await time.increase(3600);

      await expect(
        escrow.write.refund([jobId], {
          account: requester.account,
        })
      ).to.be.rejectedWith("Already released");
    });
  });

  describe("Edge cases", function () {
    it("18. getStake returns correct data after staking", async function () {
      await escrow.write.stake([jobId, provider.account.address], {
        value: stakeAmount,
        account: requester.account,
      });

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
      await escrow.write.stake([jobId, provider.account.address], {
        value: stakeAmount,
        account: requester.account,
      });
      await time.increase(3600);

      // Provider claims
      await escrow.write.claimTimeout([jobId], {
        account: provider.account,
      });

      // Requester tries to refund
      await expect(
        escrow.write.refund([jobId], {
          account: requester.account,
        })
      ).to.be.rejectedWith("Already released");
    });
  });
});
