# FNF Radar - Vercel Deployment Guide

## Quick Setup

1. **Go to Vercel**: https://vercel.com/new
2. **Import Repository**: `latest63/robin-hood-wallet-analyzer`
3. **Configure Project**:
   - Framework Preset: `Vite`
   - Root Directory: `frontend`
   - Build Command: `npm run build`
   - Output Directory: `dist`

4. **Set Environment Variables**:
   - `VITE_SUPABASE_URL` = `https://zfsraiallzuettkvfdzs.supabase.co`
   - `VITE_SUPABASE_ANON_KEY` = (get from Supabase dashboard)

5. **Deploy!**

## Supabase Setup

The database is already created with these tables:
- `users` - Wallet-based user accounts
- `clusters` - Saved clusters of profitable wallets
- `cluster_wallets` - Wallets in each cluster
- `monitors` - Active Discord webhook monitors

### Get API Keys

1. Go to: https://supabase.com/dashboard/project/zfsraiallzuettkvfdzs/settings/api
2. Copy the `anon` `public` key
3. Add to Vercel environment variables

## Features

- ✅ RainbowKit wallet auth (MetaMask, Rainbow, WalletConnect, Coinbase)
- ✅ GMGN API integration for profitable trader scanning
- ✅ Cluster building with auto-select profitable traders
- ✅ Discord webhook monitoring for buy alerts
- ✅ Robin Hood Chain (4663) support
- ✅ Mobile-first responsive design

## Architecture

```
Frontend (Vercel)
├── React + Vite
├── RainbowKit (wallet auth)
├── Supabase JS Client
└── GMGN API (direct calls)

Database (Supabase)
├── users (wallet_address PK)
├── clusters (user_wallet FK)
├── cluster_wallets (cluster_id FK)
└── monitors (cluster_id FK, user_wallet FK)
```

## Post-Deployment

1. Test wallet connection
2. Scan a token (e.g., ND4.eth: `0xa43a9b6EEdD8204F445237Bf72775eD9b1723d45`)
3. Select profitable traders
4. Save cluster
5. Start monitor with Discord webhook
6. Get alerts when cluster wallets buy!
