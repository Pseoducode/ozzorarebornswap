@echo off
cd /d %~dp0
if not exist .env (
  echo File .env belum ada. Buat dari .env.example lalu isi TREASURY_PRIVATE_KEY.
  pause
  exit /b 1
)
npm start
