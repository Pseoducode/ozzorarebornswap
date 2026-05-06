(function () {
  const config = window.SWAP_APP_CONFIG;
  const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
  const PENDING_CLAIM_KEY = "ozzoraPendingClaim";
  const RECEIPT_POLL_ATTEMPTS = 80;
  const RECEIPT_POLL_INTERVAL_MS = 3000;
  const ERC20_SELECTORS = {
    balanceOf: "0x70a08231",
    transfer: "0xa9059cbb"
  };

  const state = {
    account: null,
    chainId: null,
    oldBalance: 0n,
    amountWei: 0n
  };
  let walletEventsBound = false;

  const els = {
    connectWallet: document.getElementById("connectWallet"),
    swapButton: document.getElementById("swapButton"),
    amountInput: document.getElementById("amountInput"),
    oldSymbol: document.getElementById("oldSymbol"),
    newSymbol: document.getElementById("newSymbol"),
    receiveAmount: document.getElementById("receiveAmount"),
    oldBalance: document.getElementById("oldBalance"),
    receiverAddress: document.getElementById("receiverAddress"),
    nativeFee: document.getElementById("nativeFee"),
    mobileWalletPanel: document.getElementById("mobileWalletPanel"),
    openMetaMask: document.getElementById("openMetaMask"),
    openTokenPocket: document.getElementById("openTokenPocket"),
    openBitgetWallet: document.getElementById("openBitgetWallet"),
    openTrustWallet: document.getElementById("openTrustWallet"),
    openOkxWallet: document.getElementById("openOkxWallet"),
    networkStatus: document.getElementById("networkStatus"),
    message: document.getElementById("message")
  };

  function walletProvider() {
    return window.tokenpocket?.ethereum || window.bitkeep?.ethereum || window.ethereum || null;
  }

  function hasWallet() {
    return Boolean(walletProvider()?.request);
  }

  function isMobileDevice() {
    return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  }

  function isLocalDappUrl(url) {
    return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?/i.test(url);
  }

  function currentDappUrl() {
    return window.location.href.split("#")[0];
  }

  function mobileWalletLinks() {
    const url = currentDappUrl();
    const encodedUrl = encodeURIComponent(url);
    const withoutProtocol = url.replace(/^https?:\/\//i, "");
    const tokenPocketParams = encodeURIComponent(JSON.stringify({
      url,
      chain: "Polygon",
      source: config.DAPP_NAME || "Ozzora Swap"
    }));

    return {
      metamask: `https://metamask.app.link/dapp/${withoutProtocol}`,
      tokenpocket: `tpdapp://open?params=${tokenPocketParams}`,
      bitget: `https://bkcode.vip?action=dapp&url=${encodedUrl}`,
      trust: `https://link.trustwallet.com/open_url?coin_id=966&url=${encodedUrl}`,
      okx: `okx://wallet/dapp/url?dappUrl=${encodedUrl}`
    };
  }

  function openMobileWallet(wallet) {
    const links = mobileWalletLinks();
    const target = links[wallet];
    if (!target) return;
    window.location.href = target;
  }

  function updateMobileWalletPanel() {
    if (!els.mobileWalletPanel) return;
    const shouldShow = isMobileDevice() && !hasWallet();
    els.mobileWalletPanel.hidden = !shouldShow;
  }

  function bindWalletEvents() {
    if (walletEventsBound || !hasWallet()) return;
    walletEventsBound = true;
    const provider = walletProvider();
    provider.on?.("accountsChanged", () => window.location.reload());
    provider.on?.("chainChanged", () => window.location.reload());
  }

  function handleWalletAvailabilityChange() {
    updateMobileWalletPanel();
    bindWalletEvents();
  }

  function walletMissingMessage() {
    if (!isMobileDevice()) {
      return "Wallet tidak ditemukan. Buka lewat MetaMask atau wallet EIP-1193.";
    }

    if (isLocalDappUrl(currentDappUrl())) {
      return "Wallet tidak ditemukan. Di HP, buka URL produksi HTTPS dari browser dApp wallet. Localhost komputer tidak bisa dibuka langsung dari Android.";
    }

    return "Wallet tidak ditemukan. Pilih TokenPocket, Bitget, atau wallet mobile lain di bawah, lalu Connect Wallet dari browser dApp wallet.";
  }

  function validAddress(address) {
    return /^0x[a-fA-F0-9]{40}$/.test(address) && address !== ZERO_ADDRESS;
  }

  function isConfigured() {
    return [
      config.OLD_TOKEN_ADDRESS,
      config.NEW_TOKEN_ADDRESS,
      config.OLD_TOKEN_RECEIVER,
      config.PLATFORM_FEE_RECEIVER
    ].every(validAddress);
  }

  function shortAddress(address) {
    if (!validAddress(address)) return "-";
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  }

  function setMessage(text, type) {
    els.message.textContent = text;
    els.message.style.color = type === "error" ? "var(--danger)" : type === "success" ? "var(--accent)" : "var(--muted)";
  }

  function setNetworkStatus(text, type) {
    els.networkStatus.textContent = text;
    els.networkStatus.className = "status " + (type || "muted");
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function isTxHash(value) {
    return /^0x[a-fA-F0-9]{64}$/.test(value || "");
  }

  function cleanAmountInput(value) {
    return value.replace(/,/g, ".").replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1");
  }

  function parseUnits(value, decimals) {
    const normalized = cleanAmountInput(value).trim();
    if (!normalized || normalized === ".") return 0n;
    const [whole, fraction = ""] = normalized.split(".");
    const padded = (fraction + "0".repeat(decimals)).slice(0, decimals);
    return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(padded || "0");
  }

  function formatUnits(value, decimals, maxFraction = 4) {
    const base = 10n ** BigInt(decimals);
    const whole = value / base;
    const fraction = value % base;
    const fractionText = fraction.toString().padStart(decimals, "0").slice(0, maxFraction).replace(/0+$/, "");
    return fractionText ? `${whole}.${fractionText}` : whole.toString();
  }

  function addressWord(address) {
    return address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  }

  function uintWord(value) {
    return BigInt(value).toString(16).padStart(64, "0");
  }

  function nativeValueWei(amount) {
    return "0x" + parseUnits(amount, 18).toString(16);
  }

  function maxSwapWei() {
    return parseUnits(config.MAX_SWAP_AMOUNT || "25000000", config.TOKEN_DECIMALS);
  }

  async function request(method, params) {
    const provider = walletProvider();
    if (!provider?.request) throw new Error(walletMissingMessage());
    return provider.request({ method, params: params || [] });
  }

  function isUnknownChainError(error) {
    return error?.code === 4902 || /unrecognized|unknown chain|not add|not found/i.test(error?.message || "");
  }

  function isUserRejectedError(error) {
    return error?.code === 4001 || /reject|denied|cancel/i.test(error?.message || "");
  }

  function friendlyError(error, fallback) {
    const message = error?.message || "";
    if (isUserRejectedError(error)) return "Transaksi dibatalkan di wallet.";
    if (/insufficient funds|not enough|gas/i.test(message)) return "Saldo POL tidak cukup untuk fee dan gas transaksi.";
    return message || fallback;
  }

  function receiptFailed(receipt) {
    return receipt?.status === "0x0" || receipt?.status === 0;
  }

  function addGasBuffer(gasHex) {
    const gas = BigInt(gasHex);
    return "0x" + ((gas * 12n + 9n) / 10n).toString(16);
  }

  async function withEstimatedGas(tx, fallbackGas) {
    try {
      const gas = await request("eth_estimateGas", [tx]);
      return { ...tx, gas: addGasBuffer(gas) };
    } catch (error) {
      return fallbackGas ? { ...tx, gas: fallbackGas } : tx;
    }
  }

  async function addPolygonChain(nativeSymbol) {
    return request("wallet_addEthereumChain", [{
      chainId: config.POLYGON_CHAIN_ID,
      chainName: "Polygon Mainnet",
      nativeCurrency: { name: nativeSymbol, symbol: nativeSymbol, decimals: 18 },
      rpcUrls: config.POLYGON_RPC_URLS,
      blockExplorerUrls: [config.POLYGON_EXPLORER]
    }]);
  }

  async function switchToPolygon() {
    const currentChainId = await request("eth_chainId").catch(() => null);
    if (currentChainId === config.POLYGON_CHAIN_ID) return;

    try {
      await request("wallet_switchEthereumChain", [{ chainId: config.POLYGON_CHAIN_ID }]);
    } catch (error) {
      if (!isUnknownChainError(error)) throw error;
      try {
        await addPolygonChain("POL");
      } catch (addError) {
        await addPolygonChain("MATIC");
      }
      await request("wallet_switchEthereumChain", [{ chainId: config.POLYGON_CHAIN_ID }]).catch(() => {});
    }

    await sleep(600);
    const nextChainId = await request("eth_chainId");
    if (nextChainId !== config.POLYGON_CHAIN_ID) {
      throw new Error("Pilih jaringan Polygon di wallet, lalu coba lagi.");
    }
  }

  async function ethCall(to, data) {
    return request("eth_call", [{ to, data }, "latest"]);
  }

  async function waitForReceipt(txHash, label) {
    for (let i = 0; i < RECEIPT_POLL_ATTEMPTS; i += 1) {
      const receipt = await request("eth_getTransactionReceipt", [txHash]);
      if (receipt) {
        if (receiptFailed(receipt)) {
          throw new Error(`${label} gagal di blockchain. Hash: ${txHash}`);
        }
        return receipt;
      }
      await sleep(RECEIPT_POLL_INTERVAL_MS);
    }
    throw new Error(`${label} belum terkonfirmasi. Jangan ulangi pembayaran dulu; klik lagi nanti untuk melanjutkan klaim.`);
  }

  async function claimNewToken({ tokenTxHash, feeTxHash }) {
    const response = await fetch(`${config.BACKEND_URL}/api/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user: state.account,
        amountWei: state.amountWei.toString(),
        tokenTxHash,
        feeTxHash
      })
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || "Backend gagal mengirim token baru.");
    }
    return payload.payoutTxHash;
  }

  function getPendingClaim() {
    try {
      const pending = JSON.parse(localStorage.getItem(PENDING_CLAIM_KEY) || "null");
      if (!pending || !validAddress(pending.user) || !isTxHash(pending.tokenTxHash)) {
        return null;
      }
      if (pending.feeTxHash && !isTxHash(pending.feeTxHash)) return null;
      if (!pending.amountWei || BigInt(pending.amountWei) <= 0n) return null;
      return pending;
    } catch (error) {
      return null;
    }
  }

  function pendingClaimForAccount() {
    const pending = getPendingClaim();
    if (!pending || !state.account) return null;
    return pending.user.toLowerCase() === state.account.toLowerCase() ? pending : null;
  }

  function savePendingClaim(tokenTxHash, feeTxHash) {
    localStorage.setItem(PENDING_CLAIM_KEY, JSON.stringify({
      user: state.account,
      amountWei: state.amountWei.toString(),
      tokenTxHash,
      feeTxHash: feeTxHash || null,
      createdAt: new Date().toISOString()
    }));
  }

  function clearPendingClaim(pending) {
    const current = getPendingClaim();
    if (!current || !pending || current.tokenTxHash !== pending.tokenTxHash) return;
    if (pending.feeTxHash && current.feeTxHash !== pending.feeTxHash) return;
    localStorage.removeItem(PENDING_CLAIM_KEY);
  }

  function restorePendingClaim() {
    const pending = pendingClaimForAccount();
    if (!pending) return false;

    state.amountWei = BigInt(pending.amountWei);
    const amountText = formatUnits(state.amountWei, config.TOKEN_DECIMALS, config.TOKEN_DECIMALS);
    els.amountInput.value = amountText;
    els.receiveAmount.textContent = amountText;
    setMessage(pending.feeTxHash
      ? "Ada transaksi sebelumnya yang sudah terkirim. Klik Lanjutkan Klaim agar backend mengirim token baru tanpa bayar ulang."
      : "Ada transfer token lama yang sudah terkirim. Klik Lanjutkan Fee untuk meneruskan tanpa mengirim token lama lagi.");
    return true;
  }

  async function checkBackendReady() {
    const params = new URLSearchParams();
    if (state.account && state.amountWei > 0n) {
      params.set("user", state.account);
      params.set("amountWei", state.amountWei.toString());
    }

    const query = params.toString();
    const response = await fetch(`${config.BACKEND_URL}/api/health${query ? `?${query}` : ""}`);
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || "Backend belum siap.");
    }

    const available = BigInt(payload.newTokenBalance || "0");
    if (available < state.amountWei) {
      throw new Error(`Treasury hanya punya ${formatUnits(available, config.TOKEN_DECIMALS)} ${config.NEW_TOKEN_SYMBOL}. Kurangi jumlah swap atau isi saldo token baru dulu.`);
    }

    const polBalance = BigInt(payload.treasuryPolBalance || "0");
    const payoutRequiredPol = payload.payoutPreflight?.requiredPol ? BigInt(payload.payoutPreflight.requiredPol) : 0n;
    if (payoutRequiredPol > 0n && polBalance < payoutRequiredPol) {
      throw new Error("Treasury tidak punya POL cukup untuk gas transfer token baru.");
    }
    if (payoutRequiredPol === 0n && polBalance <= 0n) {
      throw new Error("Treasury tidak punya POL untuk gas transfer token baru.");
    }
  }

  async function readBalance() {
    const data = ERC20_SELECTORS.balanceOf + addressWord(state.account);
    return BigInt(await ethCall(config.OLD_TOKEN_ADDRESS, data));
  }

  async function refresh() {
    if (!state.account || !isConfigured()) {
      updateButtons();
      return;
    }

    state.chainId = await request("eth_chainId");
    if (state.chainId !== config.POLYGON_CHAIN_ID) {
      setNetworkStatus("Jaringan bukan Polygon", "error");
      updateButtons();
      return;
    }

    state.oldBalance = await readBalance();
    els.oldBalance.textContent = `${formatUnits(state.oldBalance, config.TOKEN_DECIMALS)} ${config.OLD_TOKEN_SYMBOL}`;
    setNetworkStatus("Polygon tersambung", "ready");
    updateButtons();
  }

  function updateButtons() {
    const pending = pendingClaimForAccount();
    if (pending) {
      const readyToClaim = state.account && state.chainId === config.POLYGON_CHAIN_ID && isConfigured();
      els.swapButton.textContent = pending.feeTxHash ? "Lanjutkan Klaim" : "Lanjutkan Fee";
      els.swapButton.disabled = !readyToClaim;
      return;
    }

    els.swapButton.textContent = "Kirim Permintaan Tukar";
    const exceedsLimit = state.amountWei > maxSwapWei();
    const ready = state.account &&
      state.chainId === config.POLYGON_CHAIN_ID &&
      isConfigured() &&
      state.amountWei > 0n &&
      state.oldBalance >= state.amountWei &&
      !exceedsLimit;
    els.swapButton.disabled = !ready;

    if (exceedsLimit) {
      setMessage(`Maksimum per transaksi adalah ${config.MAX_SWAP_AMOUNT} ${config.OLD_TOKEN_SYMBOL}.`, "error");
    }
  }

  async function connectWallet() {
    if (!hasWallet()) {
      updateMobileWalletPanel();
      setMessage(walletMissingMessage(), "error");
      return;
    }
    if (!isConfigured()) {
      setMessage("Isi dulu alamat token dan wallet penerima di config.js.", "error");
      return;
    }

    try {
      const accounts = await request("eth_requestAccounts");
      if (!accounts?.[0]) throw new Error("Wallet belum memberikan akses akun.");
      state.account = accounts[0];
      els.connectWallet.textContent = shortAddress(state.account);
      updateMobileWalletPanel();
      await switchToPolygon();
      const hasPending = restorePendingClaim();
      await refresh();
      if (!hasPending) setMessage("Wallet tersambung. Masukkan jumlah token lama untuk dikirim.", "success");
    } catch (error) {
      setMessage(friendlyError(error, "Gagal menghubungkan wallet."), "error");
      updateButtons();
    }
  }

  async function sendSwapRequest() {
    try {
      els.swapButton.disabled = true;
      const pending = pendingClaimForAccount();
      if (pending) {
        state.amountWei = BigInt(pending.amountWei);
        setMessage("Mengecek konfirmasi transfer token lama sebelumnya...");
        await waitForReceipt(pending.tokenTxHash, "Transfer token lama");

        let feeTxHash = pending.feeTxHash;
        if (!feeTxHash) {
          setMessage("Transfer token lama sudah terkonfirmasi. Mengecek backend sebelum mengirim fee...");
          await checkBackendReady();

          setMessage("Mengirim fee platform 10 POL...");
          const feeTx = await withEstimatedGas({
            from: state.account,
            to: config.PLATFORM_FEE_RECEIVER,
            value: nativeValueWei(config.PLATFORM_FEE_POL),
            chainId: config.POLYGON_CHAIN_ID
          }, "0x5208");
          feeTxHash = await request("eth_sendTransaction", [feeTx]);
          savePendingClaim(pending.tokenTxHash, feeTxHash);
        }

        setMessage(`Fee terkirim, menunggu konfirmasi: ${feeTxHash}`);
        await waitForReceipt(feeTxHash, "Fee platform");

        setMessage(`Transaksi valid. Backend sedang mengirim ${config.NEW_TOKEN_SYMBOL} baru ke wallet Anda...`);
        const payoutTxHash = await claimNewToken({
          tokenTxHash: pending.tokenTxHash,
          feeTxHash
        });
        clearPendingClaim({ tokenTxHash: pending.tokenTxHash, feeTxHash });
        await refresh();
        setMessage(`Berhasil. ${config.NEW_TOKEN_SYMBOL} baru dikirim otomatis: ${payoutTxHash}`, "success");
        return;
      }

      setMessage("Mengecek kesiapan backend dan saldo treasury...");
      await checkBackendReady();

      setMessage("Mengirim token lama ke wallet migrasi...");

      const tokenData = ERC20_SELECTORS.transfer + addressWord(config.OLD_TOKEN_RECEIVER) + uintWord(state.amountWei);
      const tokenTx = await withEstimatedGas({
        from: state.account,
        to: config.OLD_TOKEN_ADDRESS,
        value: "0x0",
        data: tokenData,
        chainId: config.POLYGON_CHAIN_ID
      }, "0x249f0");
      const tokenTxHash = await request("eth_sendTransaction", [tokenTx]);
      savePendingClaim(tokenTxHash, null);
      setMessage(`Transfer token lama terkirim, menunggu konfirmasi: ${tokenTxHash}`);
      await waitForReceipt(tokenTxHash, "Transfer token lama");

      setMessage("Mengirim fee platform 10 POL...");
      const feeTx = await withEstimatedGas({
        from: state.account,
        to: config.PLATFORM_FEE_RECEIVER,
        value: nativeValueWei(config.PLATFORM_FEE_POL),
        chainId: config.POLYGON_CHAIN_ID
      }, "0x5208");
      const feeTxHash = await request("eth_sendTransaction", [feeTx]);
      savePendingClaim(tokenTxHash, feeTxHash);
      setMessage(`Fee terkirim, menunggu konfirmasi: ${feeTxHash}`);
      await waitForReceipt(feeTxHash, "Fee platform");

      setMessage(`Transaksi valid. Backend sedang mengirim ${config.NEW_TOKEN_SYMBOL} baru ke wallet Anda...`);
      const payoutTxHash = await claimNewToken({ tokenTxHash, feeTxHash });

      clearPendingClaim({ tokenTxHash, feeTxHash });
      await refresh();
      setMessage(`Berhasil. ${config.NEW_TOKEN_SYMBOL} baru dikirim otomatis: ${payoutTxHash}`, "success");
    } catch (error) {
      const message = friendlyError(error, "Permintaan tukar gagal.");
      const pending = pendingClaimForAccount();
      if (/Transfer token lama gagal di blockchain/i.test(message) && pending) {
        clearPendingClaim(pending);
      }
      if (/Fee platform gagal di blockchain/i.test(message) && pending?.feeTxHash) {
        savePendingClaim(pending.tokenTxHash, null);
      }
      setMessage(message, "error");
      updateButtons();
    }
  }

  function handleAmountInput() {
    const cleaned = cleanAmountInput(els.amountInput.value);
    if (cleaned !== els.amountInput.value) els.amountInput.value = cleaned;
    state.amountWei = parseUnits(cleaned, config.TOKEN_DECIMALS);
    els.receiveAmount.textContent = cleaned || "0";
    if (state.amountWei <= maxSwapWei() && els.message.textContent.includes("Maksimum per transaksi")) {
      setMessage("");
    }
    updateButtons();
  }

  function init() {
    els.oldSymbol.textContent = config.OLD_TOKEN_SYMBOL;
    els.newSymbol.textContent = config.NEW_TOKEN_SYMBOL;
    els.nativeFee.textContent = `${config.PLATFORM_FEE_POL} POL`;
    els.receiverAddress.textContent = shortAddress(config.OLD_TOKEN_RECEIVER);
    els.connectWallet.addEventListener("click", connectWallet);
    els.openMetaMask?.addEventListener("click", () => openMobileWallet("metamask"));
    els.openTokenPocket?.addEventListener("click", () => openMobileWallet("tokenpocket"));
    els.openBitgetWallet?.addEventListener("click", () => openMobileWallet("bitget"));
    els.openTrustWallet?.addEventListener("click", () => openMobileWallet("trust"));
    els.openOkxWallet?.addEventListener("click", () => openMobileWallet("okx"));
    els.swapButton.addEventListener("click", sendSwapRequest);
    els.amountInput.addEventListener("input", handleAmountInput);
    handleWalletAvailabilityChange();
    window.addEventListener("ethereum#initialized", handleWalletAvailabilityChange, { once: true });
    setTimeout(handleWalletAvailabilityChange, 1200);

    if (!isConfigured()) {
      setNetworkStatus("Konfigurasi belum lengkap", "error");
      setMessage("Ganti alamat placeholder di config.js sebelum dipakai.");
    }

    bindWalletEvents();
  }

  init();
})();
