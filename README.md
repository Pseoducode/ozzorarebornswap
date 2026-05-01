# App Tukar Ozzora Otomatis Tanpa Smart Contract

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
BACKEND_URL: "http://localhost:8787"
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
- Treasury punya saldo Ozzora baru yang cukup.

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
