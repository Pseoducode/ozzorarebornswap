# App Tukar Ozzora Otomatis Tanpa Smart Contract

Swap Token lama ke token Baru.

Aplikasi ini memakai model backend treasury:

1. User mengirim Ozzora lama ke wallet migrasi.
2. User mengirim fee platform 10 POL, dan maksimum 25 juta Ozzora per transaksi ke wallet platform.
3. Backend memverifikasi dua transaksi tersebut di Polygon.
4. Backend otomatis mengirim Ozzora baru 1:1 dari wallet treasury ke wallet user.

Private key treasury hanya disimpan di backend `.env`, bukan di frontend.

## File Project

- `index.html` - UI swap
- `styles.css` - desain UI
- `config.js` - konfigurasi frontend
- `app.js` - connect wallet, kirim Ozzora lama, kirim fee, panggil backend
- `server.js` - backend verifikasi transaksi dan auto-send Ozzora baru
- `.env.example` - contoh konfigurasi backend
- `package.json` - dependency backend

## Setup Backend

Install dependency:

```bash
npm install
```

Buat file `.env` dari `.env.example`, lalu isi private key treasury:

```bash
cp .env.example .env
```

Isi bagian ini di `.env`:

```env
TREASURY_PRIVATE_KEY=0xPRIVATE_KEY_WALLET_YANG_MEMEGANG_OZZORA_BARU
```

Wallet treasury tersebut harus punya:

- Saldo Ozzora baru untuk dikirim ke user.
- Sedikit POL untuk gas transfer token.

Jalankan backend:

```bash
npm start
```

Backend berjalan di:

```txt
http://localhost:8787
```

## Setup Frontend

Pastikan `config.js` sudah benar:

```js
OLD_TOKEN_ADDRESS: "0x90aED5320D64FEcB6003ffC561F494dFE9f09a0c",
NEW_TOKEN_ADDRESS: "0xC1B8db34e833180CCB34C7338934A3c1Cefd3204",
OLD_TOKEN_RECEIVER: "0x9B97eb9943822cDb9C5a571A3904c81de4391ae1",
PLATFORM_FEE_RECEIVER: "0x9B97eb9943822cDb9C5a571A3904c81de4391ae1",
MAX_SWAP_AMOUNT: "25000000",
BACKEND_URL: window.location.origin === "null" ? "http://localhost:8787" : window.location.origin
```

Opsional di `.env` untuk membuat backend lebih sabar menunggu RPC/receipt:

```env
TX_POLL_ATTEMPTS=80
TX_POLL_INTERVAL_MS=3000
```

Token Ozzora Reborn saat ini memotong transfer 5%. Agar user tetap menerima net 1:1, backend default mengirim jumlah gross dengan tax 500 bps. Nilai ini bisa dioverride:

```env
NEW_TOKEN_TRANSFER_TAX_BPS=500
```

Buka app dari backend:

```txt
http://localhost:8787
```

## Alur User

1. Klik `Connect Wallet`.
2. Wallet pindah ke Polygon.
3. Masukkan jumlah Ozzora lama.
4. Klik `Kirim Permintaan Tukar`.
5. Approve transaksi transfer Ozzora lama.
6. Approve transaksi fee 10 POL.
7. Backend otomatis mengirim Ozzora baru ke wallet user.

## Proteksi Backend

Backend memverifikasi:

- Hash transaksi Ozzora lama benar-benar dari wallet user.
- Tujuan transaksi token lama adalah `OLD_TOKEN_RECEIVER`.
- Jumlah token lama sama dengan jumlah yang diminta.
- Hash transaksi fee benar-benar dari wallet user.
- Tujuan fee adalah `PLATFORM_FEE_RECEIVER`.
- Nilai fee tepat `10 POL`.
- Hash transaksi belum pernah diklaim.
- Klaim yang sama bisa dicoba ulang tanpa membuat user bayar ulang.
- Treasury punya saldo Ozzora baru yang cukup, termasuk gross-up tax transfer token baru.

Data klaim tersimpan di `claims.json`.

## Catatan Keamanan

- Jangan pernah memasukkan private key di `config.js`, `app.js`, atau file frontend.
- Jangan upload `.env` ke hosting publik.
- Untuk produksi, ganti `claims.json` dengan database seperti PostgreSQL/Supabase/Firebase.
- Untuk produksi, pakai RPC private/berbayar agar backend lebih stabil.
- Backend ini tetap model custodial. Solusi paling trustless tetap smart contract.

## Batas Transaksi

- Jumlah maksimum per transaksi adalah 25.000.000 Ozzora.
- Fee platform tetap 10 POL untuk setiap transaksi.
- Batas ini divalidasi di frontend dan backend.

## Android / Handphone

- Buka URL produksi dari HP, misalnya https://swap.domainanda.com.
- Frontend dan backend harus bisa diakses dari domain HTTPS yang sama, atau ubah `BACKEND_URL` ke URL backend HTTPS.
- Kalau wallet tidak terdeteksi, app menampilkan tombol MetaMask, TokenPocket, Bitget Wallet, Trust Wallet, dan OKX Wallet.
- Tombol tersebut membuka halaman swap di browser dApp wallet mobile.
- Setelah terbuka di browser dApp wallet, klik Connect Wallet seperti biasa.
- Deep link mobile hanya bekerja baik jika app sudah memakai domain HTTPS, bukan localhost.
- TokenPocket dan Bitget Wallet juga bisa langsung membuka app lewat deep link mobile. App mengecek provider khusus mereka sebelum fallback ke `window.ethereum`.

## Jika Transfer Sempat Gagal di App

- Kalau token lama dan fee sudah terkirim tapi backend/RPC belum melihat receipt, app menyimpan data pending di browser.
- Klik `Lanjutkan Fee` atau `Lanjutkan Klaim` dengan wallet yang sama. App akan meneruskan dari hash transaksi yang sudah ada tanpa mengirim token/fee kedua kalinya.
- Jangan hapus cache browser sebelum klaim selesai, karena data pending disimpan di `localStorage`.
