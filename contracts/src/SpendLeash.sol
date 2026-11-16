// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title SpendLeash
/// @notice An on-chain spending leash for AI agents.
///         An owner deposits stablecoin and opens a *session* for an agent key with hard limits:
///         per-payment cap, daily cap, lifetime cap, expiry and a merchant allowlist.
///         The agent never holds funds. It signs an EIP-712 `PaymentIntent`; anyone (usually the
///         merchant's x402 facilitator) submits it, so the agent needs no gas.
///         Whatever the agent is tricked into signing, the chain refuses anything outside the leash.
contract SpendLeash is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Limits {
        uint96 perPaymentCap;
        uint96 dailyCap;
        uint96 totalCap;
        uint40 validUntil;
    }

    struct Session {
        address owner;
        uint40 validUntil;
        bool revoked;
        address agent;
        uint32 day; // UTC day number of `spentToday`
        uint96 perPaymentCap;
        uint96 dailyCap;
        uint96 totalCap;
        uint96 spentTotal;
        uint96 spentToday;
    }

    struct PaymentIntent {
        bytes32 sessionId;
        address merchant;
        uint256 amount;
        bytes32 ref; // what is being paid for, e.g. keccak256 of the x402 resource + request id
        bytes32 nonce; // single use per session
        uint256 deadline; // unix seconds; signature is void after this
    }

    bytes32 public constant PAYMENT_INTENT_TYPEHASH = keccak256(
        "PaymentIntent(bytes32 sessionId,address merchant,uint256 amount,bytes32 ref,bytes32 nonce,uint256 deadline)"
    );

    IERC20 public immutable token;

    mapping(address owner => uint256) public balanceOf;
    mapping(bytes32 sessionId => Session) private _sessions;
    mapping(bytes32 sessionId => mapping(address merchant => bool)) public isMerchantAllowed;
    mapping(bytes32 sessionId => mapping(bytes32 nonce => bool)) public isNonceUsed;
    mapping(address owner => uint256) public sessionCount;

    event Deposited(address indexed owner, uint256 amount);
    event Withdrawn(address indexed owner, uint256 amount);
    event SessionOpened(
        bytes32 indexed sessionId, address indexed owner, address indexed agent, Limits limits, address[] merchants
    );
    event MerchantsUpdated(bytes32 indexed sessionId, address[] merchants, bool allowed);
    event SessionRevoked(bytes32 indexed sessionId, address indexed owner);
    event Paid(
        bytes32 indexed sessionId,
        address indexed merchant,
        address indexed agent,
        address owner,
        uint256 amount,
        bytes32 ref,
        bytes32 nonce
    );

    error ZeroAddress();
    error ZeroAmount();
    error NotOwner();
    error UnknownSession();
    error SessionIsRevoked();
    error SessionExpired();
    error IntentExpired();
    error NonceAlreadyUsed();
    error MerchantNotAllowed();
    error PerPaymentCapExceeded();
    error DailyCapExceeded();
    error TotalCapExceeded();
    error InsufficientDeposit();
    error BadSignature();
    error BadLimits();

    constructor(IERC20 token_) EIP712("SpendLeash", "1") {
        if (address(token_) == address(0)) revert ZeroAddress();
        token = token_;
    }

    // ───────────────────────────── owner: funds ─────────────────────────────

    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        balanceOf[msg.sender] += amount;
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount);
    }

    /// @notice Deposit with an EIP-2612 permit (one transaction, no separate approve).
    function depositWithPermit(uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        nonReentrant
    {
        if (amount == 0) revert ZeroAmount();
        // A front-run permit only spends the nonce; fall through if the allowance is already there.
        try IERC20Permit(address(token)).permit(msg.sender, address(this), amount, deadline, v, r, s) {} catch {}
        balanceOf[msg.sender] += amount;
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount);
    }

    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (balanceOf[msg.sender] < amount) revert InsufficientDeposit();
        balanceOf[msg.sender] -= amount;
        token.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    // ──────────────────────────── owner: sessions ───────────────────────────

    function openSession(address agent, Limits calldata limits, address[] calldata merchants)
        external
        returns (bytes32 sessionId)
    {
        if (agent == address(0)) revert ZeroAddress();
        if (
            limits.perPaymentCap == 0 || limits.perPaymentCap > limits.dailyCap
                || limits.dailyCap > limits.totalCap || limits.validUntil <= block.timestamp
        ) revert BadLimits();

        sessionId = keccak256(abi.encode(block.chainid, address(this), msg.sender, sessionCount[msg.sender]++));
        _sessions[sessionId] = Session({
            owner: msg.sender,
            validUntil: limits.validUntil,
            revoked: false,
            agent: agent,
            day: 0,
            perPaymentCap: limits.perPaymentCap,
            dailyCap: limits.dailyCap,
            totalCap: limits.totalCap,
            spentTotal: 0,
            spentToday: 0
        });
        for (uint256 i; i < merchants.length; ++i) {
            if (merchants[i] == address(0)) revert ZeroAddress();
            isMerchantAllowed[sessionId][merchants[i]] = true;
        }
        emit SessionOpened(sessionId, msg.sender, agent, limits, merchants);
    }

    function setMerchants(bytes32 sessionId, address[] calldata merchants, bool allowed) external {
        _onlyOwner(sessionId);
        for (uint256 i; i < merchants.length; ++i) {
            if (merchants[i] == address(0)) revert ZeroAddress();
            isMerchantAllowed[sessionId][merchants[i]] = allowed;
        }
        emit MerchantsUpdated(sessionId, merchants, allowed);
    }

    /// @notice Kill switch. Takes effect in the same block; every later payment reverts.
    function revoke(bytes32 sessionId) external {
        _onlyOwner(sessionId);
        _sessions[sessionId].revoked = true;
        emit SessionRevoked(sessionId, msg.sender);
    }

    // ─────────────────────────────── payments ───────────────────────────────

    /// @notice Settle a payment the agent signed. Callable by anyone; funds always go to `intent.merchant`.
    function pay(PaymentIntent calldata intent, bytes calldata signature) external nonReentrant {
        bytes4 err = _check(intent, signature);
        if (err != bytes4(0)) _revertWith(err);

        Session storage s = _sessions[intent.sessionId];
        uint32 today = uint32(block.timestamp / 1 days);
        if (s.day != today) {
            s.day = today;
            s.spentToday = 0;
        }
        uint96 amount = uint96(intent.amount);
        s.spentToday += amount;
        s.spentTotal += amount;
        balanceOf[s.owner] -= intent.amount;
        isNonceUsed[intent.sessionId][intent.nonce] = true;

        token.safeTransfer(intent.merchant, intent.amount);
        emit Paid(intent.sessionId, intent.merchant, s.agent, s.owner, intent.amount, intent.ref, intent.nonce);
    }

    /// @notice Dry-run a payment. Returns the selector of the error `pay` would revert with, or 0 if it would pass.
    ///         Merchants call this in the x402 "verify" step before doing any work.
    function check(PaymentIntent calldata intent, bytes calldata signature) external view returns (bytes4) {
        return _check(intent, signature);
    }

    // ───────────────────────────────── views ────────────────────────────────

    function getSession(bytes32 sessionId) external view returns (Session memory) {
        return _sessions[sessionId];
    }

    /// @notice How much the agent can still spend right now in one payment, taking every limit into account.
    function remaining(bytes32 sessionId) external view returns (uint256 perPayment, uint256 today, uint256 total) {
        Session memory s = _sessions[sessionId];
        if (s.owner == address(0) || s.revoked || block.timestamp > s.validUntil) return (0, 0, 0);
        uint256 spentToday = s.day == uint32(block.timestamp / 1 days) ? s.spentToday : 0;
        total = s.totalCap - s.spentTotal;
        today = _min(s.dailyCap - spentToday, total);
        perPayment = _min(_min(s.perPaymentCap, today), balanceOf[s.owner]);
    }

    function hashIntent(PaymentIntent calldata intent) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    PAYMENT_INTENT_TYPEHASH,
                    intent.sessionId,
                    intent.merchant,
                    intent.amount,
                    intent.ref,
                    intent.nonce,
                    intent.deadline
                )
            )
        );
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ─────────────────────────────── internal ───────────────────────────────

    function _check(PaymentIntent calldata intent, bytes calldata signature) internal view returns (bytes4) {
        Session storage s = _sessions[intent.sessionId];
        if (s.owner == address(0)) return UnknownSession.selector;
        if (s.revoked) return SessionIsRevoked.selector;
        if (block.timestamp > s.validUntil) return SessionExpired.selector;
        if (block.timestamp > intent.deadline) return IntentExpired.selector;
        if (intent.amount == 0) return ZeroAmount.selector;
        if (isNonceUsed[intent.sessionId][intent.nonce]) return NonceAlreadyUsed.selector;
        if (!isMerchantAllowed[intent.sessionId][intent.merchant]) return MerchantNotAllowed.selector;
        if (intent.amount > s.perPaymentCap) return PerPaymentCapExceeded.selector;
        uint256 spentToday = s.day == uint32(block.timestamp / 1 days) ? s.spentToday : 0;
        if (spentToday + intent.amount > s.dailyCap) return DailyCapExceeded.selector;
        if (uint256(s.spentTotal) + intent.amount > s.totalCap) return TotalCapExceeded.selector;
        if (balanceOf[s.owner] < intent.amount) return InsufficientDeposit.selector;
        if (!SignatureChecker.isValidSignatureNow(s.agent, hashIntent(intent), signature)) {
            return BadSignature.selector;
        }
        return bytes4(0);
    }

    function _onlyOwner(bytes32 sessionId) internal view {
        address owner = _sessions[sessionId].owner;
        if (owner == address(0)) revert UnknownSession();
        if (owner != msg.sender) revert NotOwner();
    }

    function _revertWith(bytes4 selector) internal pure {
        assembly ("memory-safe") {
            mstore(0, selector)
            revert(0, 4)
        }
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}
