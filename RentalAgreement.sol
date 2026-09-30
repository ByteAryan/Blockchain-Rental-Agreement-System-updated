// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title RentalAgreement
 * @notice Blockchain-based rental agreements. The landlord lists a property, the tenant
 *         signs by locking a security deposit in this contract (escrow), rent goes straight
 *         to the landlord, and the deposit is settled when the lease ends.
 *         Payments use the native currency (ETH on Sepolia).
 */
contract RentalAgreement is ReentrancyGuard {
    enum Status { Listed, Active, Completed, Terminated, Cancelled }

    uint256 public constant PERIOD = 30 days;          // one rent period
    uint256 public constant GRACE = 5 days;            // rent later than this is "late"
    uint256 public constant DEFAULT_AFTER = 30 days;   // overdue this long = landlord may terminate

    struct Agreement {
        address landlord;
        address tenant;
        string property;
        uint256 rent;       // wei per month
        uint256 deposit;    // wei, held in escrow
        uint256 months;
        uint256 monthsPaid;
        uint256 lateCount;
        uint256 startTime;
        uint256 createdAt;
        bytes32 termsHash;
        Status status;
    }

    Agreement[] private agreements; // agreement id = index

    event Created(uint256 indexed id, address indexed landlord, string property, uint256 rent, uint256 deposit, uint256 months);
    event TermsHashUpdated(uint256 indexed id, bytes32 indexed termsHash, address indexed updatedBy);
    event Cancelled(uint256 indexed id);
    event Signed(uint256 indexed id, address indexed tenant, uint256 deposit);
    event RentPaid(uint256 indexed id, address indexed tenant, uint256 amount, uint256 monthsPaid, bool late);
    event Ended(uint256 indexed id, uint256 refundedToTenant, uint256 keptByLandlord);
    event Terminated(uint256 indexed id, uint256 depositForfeited);

    function createAgreement(string calldata property, uint256 rent, uint256 deposit, uint256 months)
        external
        returns (uint256 id)
    {
        require(rent > 0, "Rent must be above zero");
        require(months > 0, "Duration must be at least 1 month");
        agreements.push(Agreement(msg.sender, address(0), property, rent, deposit, months, 0, 0, 0, block.timestamp, bytes32(0), Status.Listed));
        id = agreements.length - 1;
        emit Created(id, msg.sender, property, rent, deposit, months);
    }

    function cancelListing(uint256 id) external {
        Agreement storage a = _get(id);
        require(msg.sender == a.landlord, "Only landlord");
        require(a.status == Status.Listed, "Not listed");
        a.status = Status.Cancelled;
        emit Cancelled(id);
    }

    /// @notice Stores a hash of the off-chain rental document/terms. The document itself is not stored on-chain.
    /// @dev Only the landlord can set/update it while the listing is still open.
    function setTermsHash(uint256 id, bytes32 termsHash) external {
        Agreement storage a = _get(id);
        require(msg.sender == a.landlord, "Only landlord");
        require(a.status == Status.Listed, "Terms can only change before signing");
        require(termsHash != bytes32(0), "Terms hash required");
        a.termsHash = termsHash;
        emit TermsHashUpdated(id, termsHash, msg.sender);
    }

    /// @notice Tenant signs by sending exactly the deposit, which stays locked here.
    function signAgreement(uint256 id) external payable {
        Agreement storage a = _get(id);
        require(a.status == Status.Listed, "Not open for signing");
        require(msg.sender != a.landlord, "Landlord cannot rent own property");
        require(msg.value == a.deposit, "Send exactly the deposit");
        a.tenant = msg.sender;
        a.startTime = block.timestamp;
        a.status = Status.Active;
        emit Signed(id, msg.sender, msg.value);
    }

    /// @notice Tenant pays one month of rent, forwarded straight to the landlord.
    function payRent(uint256 id) external payable nonReentrant {
        Agreement storage a = _get(id);
        require(a.status == Status.Active, "Not active");
        require(msg.sender == a.tenant, "Only tenant");
        require(a.monthsPaid < a.months, "All rent already paid");
        require(msg.value == a.rent, "Send exactly the rent");

        bool late = block.timestamp > a.startTime + a.monthsPaid * PERIOD + GRACE;
        if (late) a.lateCount++;
        a.monthsPaid++;
        emit RentPaid(id, msg.sender, msg.value, a.monthsPaid, late);

        (bool ok, ) = a.landlord.call{value: msg.value}("");
        require(ok, "Transfer failed");
    }

    /// @notice After all rent is paid the landlord ends the lease; deposit minus deduction goes back.
    function endAgreement(uint256 id, uint256 deduction) external nonReentrant {
        Agreement storage a = _get(id);
        require(msg.sender == a.landlord, "Only landlord");
        require(a.status == Status.Active, "Not active");
        require(a.monthsPaid == a.months, "Rent not fully paid");
        require(deduction <= a.deposit, "Deduction exceeds deposit");

        a.status = Status.Completed;
        uint256 refund = a.deposit - deduction;
        emit Ended(id, refund, deduction);

        if (refund > 0) {
            (bool ok1, ) = a.tenant.call{value: refund}("");
            require(ok1, "Refund failed");
        }
        if (deduction > 0) {
            (bool ok2, ) = a.landlord.call{value: deduction}("");
            require(ok2, "Payout failed");
        }
    }

    /// @notice Landlord may terminate and keep the deposit if rent is overdue beyond DEFAULT_AFTER.
    function terminateForNonPayment(uint256 id) external nonReentrant {
        Agreement storage a = _get(id);
        require(msg.sender == a.landlord, "Only landlord");
        require(a.status == Status.Active, "Not active");
        require(a.monthsPaid < a.months, "Tenant has paid everything");
        require(block.timestamp > a.startTime + a.monthsPaid * PERIOD + DEFAULT_AFTER, "Tenant not overdue enough");

        a.status = Status.Terminated;
        emit Terminated(id, a.deposit);
        (bool ok, ) = a.landlord.call{value: a.deposit}("");
        require(ok, "Payout failed");
    }

    function nextDueDate(uint256 id) external view returns (uint256) {
        Agreement storage a = _get(id);
        return a.startTime + a.monthsPaid * PERIOD;
    }

    function getAgreement(uint256 id) external view returns (Agreement memory) {
        return _get(id);
    }

    function agreementCount() external view returns (uint256) {
        return agreements.length;
    }

    function _get(uint256 id) private view returns (Agreement storage) {
        require(id < agreements.length, "No such agreement");
        return agreements[id];
    }
}
