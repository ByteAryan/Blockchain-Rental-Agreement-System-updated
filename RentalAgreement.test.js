const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const eth = (n) => ethers.parseEther(n.toString());
const DAY = 24 * 60 * 60;
const RENT = eth(1), DEPOSIT = eth(2), MONTHS = 3;

describe("RentalAgreement", function () {
  async function listed() {
    const [landlord, tenant, stranger] = await ethers.getSigners();
    const c = await (await ethers.getContractFactory("RentalAgreement")).deploy();
    await c.connect(landlord).createAgreement("Flat 4B", RENT, DEPOSIT, MONTHS);
    return { c, landlord, tenant, stranger };
  }
  async function active() {
    const f = await listed();
    await f.c.connect(f.tenant).signAgreement(0, { value: DEPOSIT });
    return f;
  }

  it("stores and protects a rental terms hash", async function () {
    const { c, landlord } = await loadFixture(listed);
    const termsHash = ethers.keccak256(ethers.toUtf8Bytes("Flat 4B|1 ETH|2 ETH|3 months"));
    await expect(c.connect(landlord).setTermsHash(0, termsHash))
      .to.emit(c, "TermsHashUpdated")
      .withArgs(0, termsHash, landlord.address);
    const a = await c.getAgreement(0);
    expect(a.termsHash).to.equal(termsHash);
    await expect(c.connect(landlord).setTermsHash(0, ethers.keccak256(ethers.toUtf8Bytes("changed"))))
      .to.be.revertedWith("Terms can only change before signing");
  });

  it("stores a new listing and emits Created", async function () {
    const [landlord] = await ethers.getSigners();
    const c = await (await ethers.getContractFactory("RentalAgreement")).deploy();
    await expect(c.createAgreement("Flat 4B", RENT, DEPOSIT, MONTHS)).to.emit(c, "Created");
    const a = await c.getAgreement(0);
    expect(a.landlord).to.equal(landlord.address);
    expect(a.rent).to.equal(RENT);
    expect(a.status).to.equal(0); // Listed
  });

  it("rejects a zero rent or zero months", async function () {
    const c = await (await ethers.getContractFactory("RentalAgreement")).deploy();
    await expect(c.createAgreement("x", 0, 0, 1)).to.be.revertedWith("Rent must be above zero");
    await expect(c.createAgreement("x", 1, 0, 0)).to.be.revertedWith("Duration must be at least 1 month");
  });

  describe("signing", function () {
    it("activates the lease and locks the deposit in the contract", async function () {
      const { c, tenant } = await loadFixture(listed);
      await expect(c.connect(tenant).signAgreement(0, { value: DEPOSIT })).to.changeEtherBalance(c, DEPOSIT);
      const a = await c.getAgreement(0);
      expect(a.tenant).to.equal(tenant.address);
      expect(a.status).to.equal(1);
    });
    it("requires the exact deposit", async function () {
      const { c, tenant } = await loadFixture(listed);
      await expect(c.connect(tenant).signAgreement(0, { value: eth(1) })).to.be.revertedWith("Send exactly the deposit");
    });
    it("blocks the landlord from signing and blocks a second signature", async function () {
      const { c, landlord, tenant, stranger } = await loadFixture(listed);
      await expect(c.connect(landlord).signAgreement(0, { value: DEPOSIT })).to.be.revertedWith("Landlord cannot rent own property");
      await c.connect(tenant).signAgreement(0, { value: DEPOSIT });
      await expect(c.connect(stranger).signAgreement(0, { value: DEPOSIT })).to.be.revertedWith("Not open for signing");
    });
    it("lets only the landlord cancel a listing", async function () {
      const { c, landlord, stranger } = await loadFixture(listed);
      await expect(c.connect(stranger).cancelListing(0)).to.be.revertedWith("Only landlord");
      await c.connect(landlord).cancelListing(0);
      expect((await c.getAgreement(0)).status).to.equal(4);
    });
  });

  describe("rent", function () {
    it("forwards rent to the landlord", async function () {
      const { c, landlord, tenant } = await loadFixture(active);
      await expect(c.connect(tenant).payRent(0, { value: RENT }))
        .to.changeEtherBalances([tenant, landlord], [-RENT, RENT]);
      expect((await c.getAgreement(0)).monthsPaid).to.equal(1);
    });
    it("only accepts the tenant and the exact amount", async function () {
      const { c, stranger, tenant } = await loadFixture(active);
      await expect(c.connect(stranger).payRent(0, { value: RENT })).to.be.revertedWith("Only tenant");
      await expect(c.connect(tenant).payRent(0, { value: eth(2) })).to.be.revertedWith("Send exactly the rent");
    });
    it("stops after the agreed number of months", async function () {
      const { c, tenant } = await loadFixture(active);
      for (let i = 0; i < MONTHS; i++) await c.connect(tenant).payRent(0, { value: RENT });
      await expect(c.connect(tenant).payRent(0, { value: RENT })).to.be.revertedWith("All rent already paid");
    });
    it("records late payments after the grace period", async function () {
      const { c, tenant } = await loadFixture(active);
      await time.increase(36 * DAY);
      await expect(c.connect(tenant).payRent(0, { value: RENT })).to.emit(c, "RentPaid");
      expect((await c.getAgreement(0)).lateCount).to.equal(1);
    });
  });

  describe("ending", function () {
    async function fullyPaid() {
      const f = await active();
      for (let i = 0; i < MONTHS; i++) await f.c.connect(f.tenant).payRent(0, { value: RENT });
      return f;
    }
    it("refunds the deposit minus the deduction", async function () {
      const { c, landlord, tenant } = await loadFixture(fullyPaid);
      await expect(c.connect(landlord).endAgreement(0, eth(0.5)))
        .to.changeEtherBalances([tenant, landlord, c], [eth(1.5), eth(0.5), -DEPOSIT]);
      expect((await c.getAgreement(0)).status).to.equal(2);
    });
    it("rejects a deduction above the deposit, non-landlords, and early ending", async function () {
      const { c, landlord, tenant } = await loadFixture(fullyPaid);
      await expect(c.connect(landlord).endAgreement(0, eth(3))).to.be.revertedWith("Deduction exceeds deposit");
      await expect(c.connect(tenant).endAgreement(0, 0)).to.be.revertedWith("Only landlord");
      const f = await active();
      await expect(f.c.connect(f.landlord).endAgreement(0, 0)).to.be.revertedWith("Rent not fully paid");
    });
  });

  describe("termination for non-payment", function () {
    it("is blocked until the tenant is overdue, then the landlord keeps the deposit", async function () {
      const { c, landlord } = await loadFixture(active);
      await expect(c.connect(landlord).terminateForNonPayment(0)).to.be.revertedWith("Tenant not overdue enough");
      await time.increase(31 * DAY);
      await expect(c.connect(landlord).terminateForNonPayment(0))
        .to.changeEtherBalances([landlord, c], [DEPOSIT, -DEPOSIT]);
      expect((await c.getAgreement(0)).status).to.equal(3);
    });
  });
});
