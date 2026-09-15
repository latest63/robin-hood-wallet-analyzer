# FNF Radar Frontend

Profitable wallet cluster builder with RainbowKit wallet auth and Supabase backend.

## Features

- **Wallet Auth**: Connect with MetaMask, Rainbow, WalletConnect, Coinbase Wallet
- **Token Scanning**: Find profitable traders via GMGN API
- **Cluster Building**: Select traders and save as clusters
- **Buy Alerts**: Start monitors to get Discord alerts when cluster wallets buy

## Setup

1. Install dependencies:
```bash
npm install
```

2. Create `.env` file:
```bash
cp .env.example .env
```

3. Update `.env` with your Supabase credentials

4. Run development server:
```bash
npm run dev
```

5. Build for production:
```bash
npm run build
```

## Deploy to Vercel

1. Push to GitHub
2. Import project in Vercel
3. Set environment variables:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`

## Database Schema

Tables in Supabase:
- `users` - Wallet-based user accounts
- `clusters` - Saved clusters of profitable wallets
- `cluster_wallets` - Wallets in each cluster
- `monitors` - Active Discord webhook monitors

## Architecture

- **Frontend**: React + Vite + RainbowKit
- **Database**: Supabase (PostgreSQL)
- **Auth**: Wallet-based (no passwords)
- **API**: GMGN for profitable trader data
- **Alerts**: Discord webhooks
