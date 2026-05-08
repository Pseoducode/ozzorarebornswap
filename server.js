require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const PORT = Number(process.env.PORT || 8787);
const CLAIMS_FILE = path.join(__dirname, "claims.json");
const CLAIM_FAILURES_FILE = path.join(__dirname, "claim-failures.jsonl");
const TRANSFER_SELECTOR = "0xa9059cbb";
const TX_POLL_ATTEMPTS = Number(process.env.TX_POLL_ATTEMPTS || 80);
const TX_POLL_INTERVAL_MS = Number(process.env.TX_POLL_INTERVAL_MS || 3000);
const BPS_DENOMINATOR = 10000n;
const ERC20_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 value)"
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
const treasurySigner = new ethers.NonceManager(treasury);
const newToken = new ethers.Contract(process.env.NEW_TOKEN_ADDRESS, ERC20_ABI, treasurySigner);
const iface = new ethers.Interface(ERC20_ABI);
const processingClaims = new Set();
let payoutQueue = Promise.resolve();

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

function parseBasisPoints(key, fallback = "0") {
  const raw = String(process.env[key] ?? fallback).trim();
  if (!/^\d+$/.test(raw)) throw new Error(`${key} must be an integer basis point value`);

  const value = BigInt(raw);
  if (value >= BPS_DENOMINATOR) throw new Error(`${key} must be lower than 10000`);
  return value;
}

function newTokenTransferTaxBps() {
  return parseBasisPoints("NEW_TOKEN_TRANSFER_TAX_BPS", "500");
}

function grossUpPayoutAmount(netAmount) {
  const taxBps = newTokenTransferTaxBps();
  if (taxBps === 0n) return netAmount;

  const netBps = BPS_DENOMINATOR - taxBps;
  return (netAmount * BPS_DENOMINATOR + netBps - 1n) / netBps;
}

function publicError(error) {
  return error?.reason || error?.shortMessage || error?.message || "Claim failed";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadClaims() {
  if (!fs.existsSync(CLAIMS_FILE)) return { tokenTxHashes: {}, feeTxHashes: {}, payouts: [] };
  const claims = JSON.parse(fs.readFileSync(CLAIMS_FILE, "utf8"));
  return {
    tokenTxHashes: claims.tokenTxHashes || {},
    feeTxHashes: claims.feeTxHashes || {},
    payouts: claims.payouts || []
  };
}

function saveClaims(claims) {
  const tempFile = `${CLAIMS_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(claims, null, 2));
  fs.renameSync(tempFile, CLAIMS_FILE);
}

function appendClaimFailure(body, error) {
  try {
    const entry = {
      createdAt: new Date().toISOString(),
      user: body?.user && ethers.isAddress(body.user) ? normalize(body.user) : body?.user || null,
      amountWei: body?.amountWei ? String(body.amountWei) : null,
      tokenTxHash: body?.tokenTxHash || null,
      feeTxHash: body?.feeTxHash || null,
      error: publicError(error)
    };
    fs.appendFileSync(CLAIM_FAILURES_FILE, `${JSON.stringify(entry)}\n`);
  } catch (logError) {
    console.error("Failed to write claim failure log:", publicError(logError));
  }
}

function enqueuePayout(task) {
  const next = payoutQueue.then(task, task);
  payoutQueue = next.catch(() => {});
  return next;
}

function findExistingClaim(claims, tokenTxHash, feeTxHash) {
  const tokenPayoutHash = claims.tokenTxHashes[tokenTxHash];
  const feePayoutHash = claims.feeTxHashes[feeTxHash];
  if (!tokenPayoutHash && !feePayoutHash) return null;
  if (!tokenPayoutHash || !feePayoutHash || tokenPayoutHash !== feePayoutHash) {
    return { conflict: true };
  }

  return {
    payoutTxHash: tokenPayoutHash,
    payout: claims.payouts.find((payout) =>
      payout.tokenTxHash === tokenTxHash &&
      payout.feeTxHash === feeTxHash &&
      payout.payoutTxHash === tokenPayoutHash
    )
  };
}

async function waitForTransaction(txHash, label) {
  let lastError;
  for (let attempt = 0; attempt < TX_POLL_ATTEMPTS; attempt += 1) {
    try {
      const tx = await provider.getTransaction(txHash);
      if (tx) return tx;
    } catch (error) {
      lastError = error;
    }
    await sleep(TX_POLL_INTERVAL_MS);
  }

  throw new Error(`${label} transaction not found yet. Try claim again in a moment.${lastError ? ` ${publicError(lastError)}` : ""}`);
}

async function waitForConfirmedReceipt(txHash, label) {
  const minConfirmations = Number(process.env.MIN_CONFIRMATIONS || 1);
  let seenReceipt = null;
  let lastError;

  for (let attempt = 0; attempt < TX_POLL_ATTEMPTS; attempt += 1) {
    try {
      const receipt = await provider.getTransactionReceipt(txHash);
      if (receipt) {
        seenReceipt = receipt;
        if (receipt.status !== 1) throw new Error(`${label} transaction failed: ${txHash}`);

        const latest = await provider.getBlockNumber();
        const confirmations = latest - receipt.blockNumber + 1;
        if (confirmations >= minConfirmations) return receipt;
      }
    } catch (error) {
      if (/transaction failed/i.test(error.message || "")) throw error;
      lastError = error;
    }

    await sleep(TX_POLL_INTERVAL_MS);
  }

  if (seenReceipt) {
    const latest = await provider.getBlockNumber();
    const confirmations = latest - seenReceipt.blockNumber + 1;
    throw new Error(`${label} needs ${minConfirmations} confirmation(s), currently ${confirmations}. Try claim again in a moment.`);
  }

  throw new Error(`${label} receipt not found yet. Try claim again in a moment.${lastError ? ` ${publicError(lastError)}` : ""}`);
}

async function verifyOldTokenTransfer({ tokenTxHash, user, amountWei }) {
  const tx = await waitForTransaction(tokenTxHash, "Old token");
  await waitForConfirmedReceipt(tokenTxHash, "Old token");

  if (!sameAddress(tx.from, user)) throw new Error("Old token sender does not match wallet");
  if (!sameAddress(tx.to, process.env.OLD_TOKEN_ADDRESS)) throw new Error("Old token transaction target is invalid");
  if (!tx.data.toLowerCase().startsWith(TRANSFER_SELECTOR)) throw new Error("Old token transaction is not transfer()");

  const parsed = iface.parseTransaction({ data: tx.data, value: tx.value });
  if (!sameAddress(parsed.args[0], process.env.OLD_TOKEN_RECEIVER)) throw new Error("Old token receiver is invalid");
  if (parsed.args[1] !== amountWei) throw new Error("Old token amount does not match request");
}

async function verifyFeeTransfer({ feeTxHash, user }) {
  const tx = await waitForTransaction(feeTxHash, "Fee");
  await waitForConfirmedReceipt(feeTxHash, "Fee");

  const requiredFee = ethers.parseEther(process.env.PLATFORM_FEE_POL || "10");
  if (!sameAddress(tx.from, user)) throw new Error("Fee sender does not match wallet");
  if (!sameAddress(tx.to, process.env.PLATFORM_FEE_RECEIVER)) throw new Error("Fee receiver is invalid");
  if (tx.value !== requiredFee) throw new Error("Fee amount is invalid");
}

async function assertPayoutReady({ user, amount }) {
  const payoutAmount = grossUpPayoutAmount(amount);
  const transferTaxBps = newTokenTransferTaxBps();
  const [treasuryBalance, treasuryPolBalance] = await Promise.all([
    newToken.balanceOf(treasury.address),
    provider.getBalance(treasury.address)
  ]);

  if (treasuryBalance < payoutAmount) {
    throw new Error(`Treasury has insufficient new token balance. Available ${ethers.formatUnits(treasuryBalance, tokenDecimals())}, requested net ${ethers.formatUnits(amount, tokenDecimals())}, payout gross ${ethers.formatUnits(payoutAmount, tokenDecimals())}`);
  }

  let transferResult;
  let gasEstimate;
  try {
    transferResult = await newToken.transfer.staticCall(user, payoutAmount);
    if (transferResult === false) throw new Error("New token transfer returned false");
    gasEstimate = await newToken.transfer.estimateGas(user, payoutAmount);
  } catch (error) {
    throw new Error(`New token payout preflight failed: ${publicError(error)}`);
  }

  const feeData = await provider.getFeeData();
  const gasPrice = feeData.maxFeePerGas || feeData.gasPrice;
  let requiredPol = null;
  if (gasPrice) {
    requiredPol = gasEstimate * gasPrice * 2n;
    if (treasuryPolBalance < requiredPol) {
      throw new Error(`Treasury has insufficient POL for payout gas. Available ${ethers.formatEther(treasuryPolBalance)}, estimated required ${ethers.formatEther(requiredPol)}`);
    }
  } else if (treasuryPolBalance <= 0n) {
    throw new Error("Treasury has no POL for payout gas");
  }

  return {
    payoutAmount,
    transferTaxBps,
    treasuryBalance,
    treasuryPolBalance,
    gasEstimate,
    gasPrice,
    requiredPol,
    transferResult
  };
}

function receivedAmountFromPayoutReceipt(receipt, user) {
  let received = 0n;

  for (const log of receipt.logs || []) {
    if (!sameAddress(log.address, process.env.NEW_TOKEN_ADDRESS)) continue;

    try {
      const parsed = iface.parseLog(log);
      if (
        parsed?.name === "Transfer" &&
        sameAddress(parsed.args.from, treasury.address) &&
        sameAddress(parsed.args.to, user)
      ) {
        received += parsed.args.value;
      }
    } catch (error) {
      // Ignore non-ERC20 logs emitted by token hooks.
    }
  }

  return received;
}

async function sendPayoutAndRecordClaim({ user, amount, tokenTxHash, feeTxHash }) {
  return enqueuePayout(async () => {
    const claims = loadClaims();
    const existingClaim = findExistingClaim(claims, tokenTxHash, feeTxHash);
    if (existingClaim?.conflict) {
      throw new Error("One of these transactions was already used by another claim");
    }
    if (existingClaim) {
      if (existingClaim.payout) {
        const sameUser = sameAddress(existingClaim.payout.user, user);
        const sameAmount = BigInt(existingClaim.payout.amountWei) === amount;
        if (!sameUser || !sameAmount) {
          throw new Error("Transaction already claimed by another wallet or amount");
        }
        if (existingClaim.payout.payoutUnderpaid) {
          throw new Error(`Previous payout underpaid user. Manual review required for payout ${existingClaim.payoutTxHash}`);
        }
      }
      return { alreadyClaimed: true, payoutTxHash: existingClaim.payoutTxHash };
    }

    const preflight = await assertPayoutReady({ user, amount });

    let payoutTx;
    let payoutReceipt;
    try {
      payoutTx = await newToken.transfer(user, preflight.payoutAmount);
      payoutReceipt = await payoutTx.wait(Number(process.env.MIN_CONFIRMATIONS || 1));
    } catch (error) {
      treasurySigner.reset();
      throw new Error(`New token payout failed: ${publicError(error)}`);
    }

    const receivedAmount = receivedAmountFromPayoutReceipt(payoutReceipt, user);
    const payoutUnderpaid = receivedAmount < amount;

    claims.tokenTxHashes[tokenTxHash] = payoutTx.hash;
    claims.feeTxHashes[feeTxHash] = payoutTx.hash;
    claims.payouts.push({
      user: normalize(user),
      amountWei: amount.toString(),
      payoutAmountWei: preflight.payoutAmount.toString(),
      receivedAmountWei: receivedAmount.toString(),
      newTokenTransferTaxBps: preflight.transferTaxBps.toString(),
      payoutUnderpaid,
      tokenTxHash,
      feeTxHash,
      payoutTxHash: payoutTx.hash,
      payoutBlockNumber: payoutReceipt.blockNumber,
      createdAt: new Date().toISOString()
    });
    saveClaims(claims);

    if (payoutUnderpaid) {
      throw new Error(`New token payout underpaid user. Expected net ${ethers.formatUnits(amount, tokenDecimals())}, received ${ethers.formatUnits(receivedAmount, tokenDecimals())}. Payout ${payoutTx.hash} was recorded and needs manual review.`);
    }

    return { alreadyClaimed: false, payoutTxHash: payoutTx.hash };
  });
}

app.get("/api/health", async (req, res) => {
  try {
    const treasuryBalance = await newToken.balanceOf(treasury.address);
    const treasuryPolBalance = await provider.getBalance(treasury.address);
    const payload = {
      ok: true,
      treasury: treasury.address,
      newTokenBalance: treasuryBalance.toString(),
      newTokenBalanceFormatted: ethers.formatUnits(treasuryBalance, tokenDecimals()),
      treasuryPolBalance: treasuryPolBalance.toString(),
      treasuryPolBalanceFormatted: ethers.formatEther(treasuryPolBalance),
      maxSwapAmount: (process.env.MAX_SWAP_AMOUNT || "25000000").toString()
    };

    if (req.query.user || req.query.amountWei) {
      const user = String(req.query.user || "");
      const amountWei = String(req.query.amountWei || "");
      if (!ethers.isAddress(user)) throw new Error("Invalid user wallet");
      if (!/^\d+$/.test(amountWei)) throw new Error("Invalid amount");

      const amount = BigInt(amountWei);
      if (amount <= 0n) throw new Error("Invalid amount");
      if (amount > maxSwapAmountWei()) throw new Error(`Maximum swap per transaction is ${process.env.MAX_SWAP_AMOUNT || "25000000"} Ozzora`);

      const preflight = await assertPayoutReady({ user, amount });
      payload.payoutPreflight = {
        payoutAmount: preflight.payoutAmount.toString(),
        payoutAmountFormatted: ethers.formatUnits(preflight.payoutAmount, tokenDecimals()),
        newTokenTransferTaxBps: preflight.transferTaxBps.toString(),
        gasEstimate: preflight.gasEstimate.toString(),
        gasPrice: preflight.gasPrice ? preflight.gasPrice.toString() : null,
        requiredPol: preflight.requiredPol ? preflight.requiredPol.toString() : null
      };
    }

    res.json(payload);
  } catch (error) {
    res.status(503).json({ ok: false, error: publicError(error) });
  }
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
    const existingClaim = findExistingClaim(claims, tokenTxHash, feeTxHash);
    if (existingClaim?.conflict) {
      return res.status(409).json({ ok: false, error: "One of these transactions was already used by another claim" });
    }
    if (existingClaim) {
      if (existingClaim.payout) {
        const sameUser = sameAddress(existingClaim.payout.user, user);
        const sameAmount = BigInt(existingClaim.payout.amountWei) === amount;
        if (!sameUser || !sameAmount) {
          return res.status(409).json({ ok: false, error: "Transaction already claimed by another wallet or amount" });
        }
        if (existingClaim.payout.payoutUnderpaid) {
          return res.status(409).json({ ok: false, error: `Previous payout underpaid user. Manual review required for payout ${existingClaim.payoutTxHash}` });
        }
      }
      return res.json({ ok: true, alreadyClaimed: true, payoutTxHash: existingClaim.payoutTxHash });
    }
    if (processingClaims.has(tokenTxHash) || processingClaims.has(feeTxHash)) {
      return res.status(409).json({ ok: false, error: "Transaction claim is already processing" });
    }

    processingClaims.add(tokenTxHash);
    processingClaims.add(feeTxHash);

    await verifyOldTokenTransfer({ tokenTxHash, user, amountWei: amount });
    await verifyFeeTransfer({ feeTxHash, user });

    const payout = await sendPayoutAndRecordClaim({ user, amount, tokenTxHash, feeTxHash });
    res.json({ ok: true, alreadyClaimed: payout.alreadyClaimed, payoutTxHash: payout.payoutTxHash });
  } catch (error) {
    appendClaimFailure(req.body || {}, error);
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
