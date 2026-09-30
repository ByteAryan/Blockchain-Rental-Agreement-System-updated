const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying Blockchain-Based Rental Agreement System with:", deployer.address);

  const c = await (await hre.ethers.getContractFactory("RentalAgreement")).deploy();
  await c.waitForDeployment();
  const address = await c.getAddress();
  console.log("RentalAgreement deployed to:", address);
  console.log("Save this contract address for the frontend / MetaMask integration:", address);

  if (hre.network.name === "sepolia") {
    await c.deploymentTransaction().wait(5);
    await hre.run("verify:verify", { address, constructorArguments: [] });
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
