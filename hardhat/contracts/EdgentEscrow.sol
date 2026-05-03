// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

contract EdgentEscrow {
    uint256 public constant RELEASE_TIMEOUT = 1 hours;

    IERC20 public usdc;

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

    constructor(address _operator, address _usdc) {
        operator = _operator;
        usdc = IERC20(_usdc);
    }

    // requester must approve this contract for `amount` USDC before calling
    function stake(bytes32 jobId, address providerAddress, uint256 amount) external {
        require(stakes[jobId].requester == address(0), "Job ID already exists");
        require(amount > 0, "Must stake some USDC");
        require(providerAddress != address(0), "Provider cannot be zero address");

        require(usdc.transferFrom(msg.sender, address(this), amount), "USDC transfer failed");

        stakes[jobId] = StakeData({
            requester: msg.sender,
            provider: providerAddress,
            amount: amount,
            outputHash: bytes32(0),
            released: false,
            stakedAt: block.timestamp
        });

        emit Staked(jobId, msg.sender, providerAddress, amount);
    }

    // requester (or operator) calls this after ZK proof verified
    function release(bytes32 jobId, bytes32 outputHash) external {
        StakeData storage s = stakes[jobId];
        require(msg.sender == s.requester || msg.sender == operator, "Not authorized");
        require(!s.released, "Already released");

        s.outputHash = outputHash;
        s.released = true;

        require(usdc.transfer(s.provider, s.amount), "USDC transfer failed");

        emit Released(jobId, outputHash, s.amount);
    }

    function claimTimeout(bytes32 jobId) external {
        StakeData storage s = stakes[jobId];
        require(msg.sender == s.provider, "Only provider can claim timeout");
        require(!s.released, "Already released");
        require(block.timestamp >= s.stakedAt + RELEASE_TIMEOUT, "Timeout not reached");

        s.released = true;
        require(usdc.transfer(s.provider, s.amount), "USDC transfer failed");

        emit TimeoutClaimed(jobId, s.provider, s.amount);
    }

    function refund(bytes32 jobId) external {
        StakeData storage s = stakes[jobId];
        require(msg.sender == s.requester, "Only requester");
        require(!s.released, "Already released");
        require(block.timestamp >= s.stakedAt + RELEASE_TIMEOUT, "Too early");

        s.released = true;
        require(usdc.transfer(s.requester, s.amount), "USDC refund failed");

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
