# Vercel Serverless API structure
# Each endpoint is a separate file in /api/

api/
├── auth/
│   ├── nonce.py      # POST /api/auth/nonce
│   └── verify.py     # POST /api/auth/verify
├── scan.py           # POST /api/scan
├── cluster/
│   ├── save.py       # POST /api/cluster/save
│   └── [id].py       # GET/DELETE /api/cluster/:id
├── user/
│   └── profile.py    # GET /api/user/profile
├── monitor/
│   └── start.py      # POST /api/monitor/start
└── cron/
    └── check.py      # Vercel Cron Job (every 5 min)
