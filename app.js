(function () {
  const config = window.SWAP_APP_CONFIG;
  const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
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
    openTrustWallet: document.getElementById("openTrustWallet"),
    openOkxWallet: document.getElementById("openOkxWallet"),
    networkStatus: document.getElementById("networkStatus"),
    message: document.getElementById("message")
  };

  function hasWallet() {
    return Boolean(window.ethereum?.request);
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
    return {
      metamask: `https://metamask.app.link/dapp/${withoutProtocol}`,
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
    window.ethereum.on?.("accountsChanged", () => window.location.reload());
    window.ethereum.on?.("chainChanged", () => window.location.reload());
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

    return "Wallet tidak ditemukan. Pilih wallet mobile di bawah, lalu Connect Wallet dari browser dApp wallet.";
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
    return window.ethereum.request({ method, params });
  }

  async function switchToPolygon() {
    try {
      await request("wallet_switchEthereumChain", [{ chainId: config.POLYGON_CHAIN_ID }]);
    } catch (error) {
      if (error.code !== 4902) throw error;
      await request("wallet_addEthereumChain", [{
        chainId: config.POLYGON_CHAIN_ID,
        chainName: "Polygon",
        nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
        rpcUrls: config.POLYGON_RPC_URLS,
        blockExplorerUrls: [config.POLYGON_EXPLORER]
      }]);
    }
  }

  async function ethCall(to, data) {
    return request("eth_call", [{ to, data }, "latest"]);
  }

  async function waitForReceipt(txHash) {
    for (let i = 0; i < 40; i += 1) {
      const receipt = await request("eth_getTransactionReceipt", [txHash]);
      if (receipt) return receipt;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    return null;
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

  async function checkBackendReady() {
    const response = await fetch(`${config.BACKEND_URL}/api/health`);
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || "Backend belum siap.");
    }

    const available = BigInt(payload.newTokenBalance || "0");
    if (available < state.amountWei) {
      throw new Error(`Treasury hanya punya ${formatUnits(available, config.TOKEN_DECIMALS)} ${config.NEW_TOKEN_SYMBOL}. Kurangi jumlah swap atau isi saldo token baru dulu.`);
    }

    const polBalance = BigInt(payload.treasuryPolBalance || "0");
    if (polBalance <= 0n) {
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
      await refresh();
      setMessage("Wallet tersambung. Masukkan jumlah token lama untuk dikirim.", "success");
    } catch (error) {
      setMessage(error.message || "Gagal menghubungkan wallet.", "error");
      updateButtons();
    }
  }

  async function sendSwapRequest() {
    try {
      els.swapButton.disabled = true;
      setMessage("Mengecek kesiapan backend dan saldo treasury...");
      await checkBackendReady();

      setMessage("Mengirim token lama ke wallet migrasi...");

      const tokenData = ERC20_SELECTORS.transfer + addressWord(config.OLD_TOKEN_RECEIVER) + uintWord(state.amountWei);
      const tokenTxHash = await request("eth_sendTransaction", [{
        from: state.account,
        to: config.OLD_TOKEN_ADDRESS,
        data: tokenData
      }]);
      setMessage(`Transfer token lama terkirim, menunggu konfirmasi: ${tokenTxHash}`);
      await waitForReceipt(tokenTxHash);

      setMessage("Mengirim fee platform 10 POL...");
      const feeTxHash = await request("eth_sendTransaction", [{
        from: state.account,
        to: config.PLATFORM_FEE_RECEIVER,
        value: nativeValueWei(config.PLATFORM_FEE_POL)
      }]);
      setMessage(`Fee terkirim, menunggu konfirmasi: ${feeTxHash}`);
      await waitForReceipt(feeTxHash);

      setMessage(`Transaksi valid. Backend sedang mengirim ${config.NEW_TOKEN_SYMBOL} baru ke wallet Anda...`);
      const payoutTxHash = await claimNewToken({ tokenTxHash, feeTxHash });

      await refresh();
      setMessage(`Berhasil. ${config.NEW_TOKEN_SYMBOL} baru dikirim otomatis: ${payoutTxHash}`, "success");
    } catch (error) {
      setMessage(error.message || "Permintaan tukar gagal.", "error");
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
