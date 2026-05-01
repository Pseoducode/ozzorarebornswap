require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const PORT = Number(process.env.PORT || 8787);
const CLAIMS_FILE = path.join(__dirname, "claims.json");
const TRANSFER_SELECTOR = "0xa9059cbb";
const ERC20_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)"
];

const requiredEnv = [
  "RPC_URL",
  "OLD_TOKEN_ADDRESS",
  "NEW_TOKEN_ADDRESS",
  "OLD_TOKEN_RECEIVER",
  "PLATFORM_FEE_RECEIVER",
  "TREASURY_PRIVATE_KEY"
];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    throw new Error(`Missing env: ${key}`);
  }
}

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const privateKey = String(process.env.TREASURY_PRIVATE_KEY || "").trim();
if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey) || /^0x0{64}$/.test(privateKey)) {
  throw new Error("TREASURY_PRIVATE_KEY must be a real 64-byte private key with 0x prefix, not a placeholder or zero key");
}

const treasury = new ethers.Wallet(privateKey, provider);
const newToken = new ethers.Contract(process.env.NEW_TOKEN_ADDRESS, ERC20_ABI, treasury);
const iface = new ethers.Interface(ERC20_ABI);
const processingClaims = new Set();

const app = express();
app.use(express.json({ limit: "32kb" }));
app.use(express.static(__dirname));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  return next();
});

function normalize(address) {
  return ethers.getAddress(address);
}

function sameAddress(a, b) {
  return normalize(a) === normalize(b);
}

function maxSwapAmountWei() {
  return ethers.parseUnits(process.env.MAX_SWAP_AMOUNT || "25000000", Number(process.env.TOKEN_DECIMALS || 18));
}

function tokenDecimals() {
  return Number(process.env.TOKEN_DECIMALS || 18);
}

function publicError(error) {
  return error?.reason || error?.shortMessage || error?.message || "Claim failed";
}

function loadClaims() {
  if (!fs.existsSync(CLAIMS_FILE)) return { tokenTxHashes: {}, feeTxHashes: {}, payouts: [] };
  return JSON.parse(fs.readFileSync(CLAIMS_FILE, "utf8"));
}

function saveClaims(claims) {
  fs.writeFileSync(CLAIMS_FILE, JSON.stringify(claims, null, 2));
}

async function waitForConfirmedReceipt(txHash) {
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) throw new Error(`Transaction not found: ${txHash}`);
  if (receipt.status !== 1) throw new Error(`Transaction failed: ${txHash}`);

  const minConfirmations = Number(process.env.MIN_CONFIRMATIONS || 1);
  const latest = await provider.getBlockNumber();
  const confirmations = latest - receipt.blockNumber + 1;
  if (confirmations < minConfirmations) {
    throw new Error(`Need ${minConfirmations} confirmation(s), currently ${confirmations}`);
  }

  return receipt;
}

async function verifyOldTokenTransfer({ tokenTxHash, user, amountWei }) {
  const tx = await provider.getTransaction(tokenTxHash);
  if (!tx) throw new Error("Old token transaction not found");
  await waitForConfirmedReceipt(tokenTxHash);

  if (!sameAddress(tx.from, user)) throw new Error("Old token sender does not match wallet");
  if (!sameAddress(tx.to, process.env.OLD_TOKEN_ADDRESS)) throw new Error("Old token transaction target is invalid");
  if (!tx.data.toLowerCase().startsWith(TRANSFER_SELECTOR)) throw new Error("Old token transaction is not transfer()");

  const parsed = iface.parseTransaction({ data: tx.data, value: tx.value });
  if (!sameAddress(parsed.args[0], process.env.OLD_TOKEN_RECEIVER)) throw new Error("Old token receiver is invalid");
  if (parsed.args[1] !== amountWei) throw new Error("Old token amount does not match request");
}

async function verifyFeeTransfer({ feeTxHash, user }) {
  const tx = await provider.getTransaction(feeTxHash);
  if (!tx) throw new Error("Fee transaction not found");
  await waitForConfirmedReceipt(feeTxHash);

  const requiredFee = ethers.parseEther(process.env.PLATFORM_FEE_POL || "10");
  if (!sameAddress(tx.from, user)) throw new Error("Fee sender does not match wallet");
  if (!sameAddress(tx.to, process.env.PLATFORM_FEE_RECEIVER)) throw new Error("Fee receiver is invalid");
  if (tx.value !== requiredFee) throw new Error("Fee amount is invalid");
}

app.get("/api/health", async (req, res) => {
  const treasuryBalance = await newToken.balanceOf(treasury.address);
  const treasuryPolBalance = await provider.getBalance(treasury.address);
  res.json({
    ok: true,
    treasury: treasury.address,
    newTokenBalance: treasuryBalance.toString(),
    newTokenBalanceFormatted: ethers.formatUnits(treasuryBalance, tokenDecimals()),
    treasuryPolBalance: treasuryPolBalance.toString(),
    treasuryPolBalanceFormatted: ethers.formatEther(treasuryPolBalance),
    maxSwapAmount: (process.env.MAX_SWAP_AMOUNT || "25000000").toString()
  });
});

app.post("/api/claim", async (req, res) => {
  try {
    const { user, amountWei, tokenTxHash, feeTxHash } = req.body || {};
    if (!ethers.isAddress(user)) throw new Error("Invalid user wallet");
    if (!/^0x[a-fA-F0-9]{64}$/.test(tokenTxHash || "")) throw new Error("Invalid old token tx hash");
    if (!/^0x[a-fA-F0-9]{64}$/.test(feeTxHash || "")) throw new Error("Invalid fee tx hash");

    const amount = BigInt(amountWei);
    if (amount <= 0n) throw new Error("Invalid amount");
    if (amount > maxSwapAmountWei()) throw new Error(`Maximum swap per transaction is ${process.env.MAX_SWAP_AMOUNT || "25000000"} Ozzora`);

    const claims = loadClaims();
    if (claims.tokenTxHashes[tokenTxHash] || claims.feeTxHashes[feeTxHash]) {
      return res.status(409).json({ ok: false, error: "Transaction already claimed" });
    }
    if (processingClaims.has(tokenTxHash) || processingClaims.has(feeTxHash)) {
      return res.status(409).json({ ok: false, error: "Transaction claim is already processing" });
    }

    processingClaims.add(tokenTxHash);
    processingClaims.add(feeTxHash);

    await verifyOldTokenTransfer({ tokenTxHash, user, amountWei: amount });
    await verifyFeeTransfer({ feeTxHash, user });

    const treasuryBalance = await newToken.balanceOf(treasury.address);
    if (treasuryBalance < amount) {
      throw new Error(`Treasury has insufficient new token balance. Available ${ethers.formatUnits(treasuryBalance, tokenDecimals())}, requested ${ethers.formatUnits(amount, tokenDecimals())}`);
    }

    let payoutTx;
    let payoutReceipt;
    try {
      payoutTx = await newToken.transfer(user, amount);
      payoutReceipt = await payoutTx.wait(Number(process.env.MIN_CONFIRMATIONS || 1));
    } catch (error) {
      throw new Error(`New token payout failed: ${publicError(error)}`);
    }

    claims.tokenTxHashes[tokenTxHash] = payoutTx.hash;
    claims.feeTxHashes[feeTxHash] = payoutTx.hash;
    claims.payouts.push({
      user: normalize(user),
      amountWei: amount.toString(),
      tokenTxHash,
      feeTxHash,
      payoutTxHash: payoutTx.hash,
      payoutBlockNumber: payoutReceipt.blockNumber,
      createdAt: new Date().toISOString()
    });
    saveClaims(claims);

    res.json({ ok: true, payoutTxHash: payoutTx.hash });
  } catch (error) {
    res.status(400).json({ ok: false, error: publicError(error) });
  } finally {
    const { tokenTxHash, feeTxHash } = req.body || {};
    if (tokenTxHash) processingClaims.delete(tokenTxHash);
    if (feeTxHash) processingClaims.delete(feeTxHash);
  }
});

app.listen(PORT, () => {
  console.log(`Ozzora migration backend running at http://localhost:${PORT}`);
  console.log(`Treasury wallet: ${treasury.address}`);
});
