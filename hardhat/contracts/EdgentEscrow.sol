// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract EdgentEscrow {
    uint256 public constant RELEASE_TIMEOUT = 1 hours;

    struct StakeData {
        address requester;
        address provider;
        uint256 amount;
        bytes32 outputHash;
        bool released;
        uint256 stakedAt;
    }

    mapping(bytes32 => StakeData) public stakes;

    address public operator;

    event Staked(bytes32 indexed jobId, address indexed requester, address indexed provider, uint256 amount);
    event Released(bytes32 indexed jobId, bytes32 outputHash, uint256 amount);
    event TimeoutClaimed(bytes32 indexed jobId, address indexed provider, uint256 amount);
    event Refunded(bytes32 indexed jobId, address indexed requester, uint256 amount);

    constructor(address _operator) {
        operator = _operator;
    }

    // requester locks ETH for simplicity on testnet
    function stake(bytes32 jobId, address providerAddress) external payable {
        require(stakes[jobId].requester == address(0), "Job ID already exists");
        require(msg.value > 0, "Must stake some ETH");
        require(providerAddress != address(0), "Provider cannot be zero address");

        stakes[jobId] = StakeData({
            requester: msg.sender,
            provider: providerAddress,
            amount: msg.value,
            outputHash: bytes32(0),
            released: false,
            stakedAt: block.timestamp
        });

        emit Staked(jobId, msg.sender, providerAddress, msg.value);
    }

    // requester calls this after ZK proof verified
    function release(bytes32 jobId, bytes32 outputHash) external {
        StakeData storage s = stakes[jobId];
        require(msg.sender == s.requester || msg.sender == operator, "Not authorized");
        require(!s.released, "Already released");

        s.outputHash = outputHash;
        s.released = true;

        (bool success, ) = s.provider.call{value: s.amount}("");
        require(success, "ETH transfer failed");

        emit Released(jobId, outputHash, s.amount);
    }

    function claimTimeout(bytes32 jobId) external {
        StakeData storage s = stakes[jobId];
        require(msg.sender == s.provider, "Only provider can claim timeout");
        require(!s.released, "Already released");
        require(block.timestamp >= s.stakedAt + RELEASE_TIMEOUT, "Timeout not reached");

        s.released = true;
        (bool success, ) = s.provider.call{value: s.amount}("");
        require(success, "ETH transfer failed");

        emit TimeoutClaimed(jobId, s.provider, s.amount);
    }

    function refund(bytes32 jobId) external {
        StakeData storage s = stakes[jobId];
        require(msg.sender == s.requester, "Only requester");
        require(!s.released, "Already released");
        require(block.timestamp >= s.stakedAt + RELEASE_TIMEOUT, "Too early");

        s.released = true;
        (bool success, ) = s.requester.call{value: s.amount}("");
        require(success, "Refund failed");

        emit Refunded(jobId, s.requester, s.amount);
    }

    // Provider calls this before starting work to confirm funds are locked
    function getStake(bytes32 jobId) external view returns (
        address requester,
        address provider,
        uint256 amount,
        bool released
    ) {
        StakeData storage s = stakes[jobId];
        return (s.requester, s.provider, s.amount, s.released);
    }
}
