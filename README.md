# FnF Radar - Robin Hood Chain Wallet Analyzer

Real-time wallet analysis tool for Robin Hood Chain mainnet (chain 4663).

## Features

- **CA-first scanning**: Enter any token contract address
- **Early buyer detection**: Find wallets that bought in first 5 minutes
- **Bot filtering**: Automatically filters contracts, pools, and burners
- **Live blockchain queries**: Uses RPC + Blockscout Pro API
- **Rich alerts**: Discord notifications with ring composition

## Quick Start

### 1. Install dependencies
```bash
pip install -r requirements.txt
```

### 2. Start API server
```bash
python api_server.py
```

### 3. Open frontend
```bash
open index.html
```

## API Endpoints

### POST /scan
Scan a token contract for early buyers
```json
{
  "address": "0x...",
  "block_range": 5000
}
```

### GET /wallet/{address}
Get wallet analysis
```
GET /wallet/0x24d6...
```

## Architecture

- `api_server.py` - FastAPI backend with RPC calls to mainnet
- `index.html` - Frontend dashboard (mobile-first, 375px)
- `fnf_ring.py` - Ring detection with recurrence scoring
- `fnf_check.py` - CA-first deploy block scanner
- `wallet_analyzer.py` - Individual wallet analysis

## Configuration

Edit `fnf_config.json`:
- `discord_webhook` - Alert webhook URL
- `buy_event` - Swap event topic filter
- `block_seconds` - Block time (0.117s)
- Scoring thresholds: recurrence 45%, size 35%, ETH 20%

## Usage

1. Get a token contract address from DEX or Telegram
2. Enter it in the scanner
3. View early buyers filtered by type
4. Export results or add to ring monitor

## Network

- **Mainnet only**: Chain ID 4663
- **RPC**: https://rpc.mainnet.chain.robinhood.com
- **Explorer**: https://explorer.testnet.chain.robinhood.com
