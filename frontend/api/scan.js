// Vercel Serverless Function - Early Buyers Scan (RPC-based)
// Scans token transfers via RPC to find PoolManager distributions

import { execSync } from 'child_process';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SCRIPT_PATH = join(__dirname, '../../scan_early_buyers.py');

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const { address } = req.method === 'POST' ? req.body : req.query;

    if (!address || !address.startsWith('0x')) {
      return res.status(400).json({ error: 'Missing or invalid contract address' });
    }

    // Run the Python scanner with timeout
    const result = execSync(
      `python3 "${SCRIPT_PATH}" "${address}"`,
      { encoding: 'utf8', timeout: 90000 }
    );

    // Parse output into structured data
    const lines = result.split('\n').filter(l => l.trim());
    const scan = {
      token: null,
      totalTransfers: 0,
      uniqueWallets: 0,
      pmDistribution: [],
      topBuyers: [],
      earlyBuyers: []
    };

    let section = null;
    
    for (const line of lines) {
      // Token line
      if (line.startsWith('Token:')) {
        scan.token = line.replace('Token:', '').trim();
      }
      // Stats lines
      else if (line.startsWith('Total transfers:')) {
        scan.totalTransfers = parseInt(line.replace('Total transfers:', '').trim()) || 0;
      }
      else if (line.startsWith('Unique wallets:')) {
        scan.uniqueWallets = parseInt(line.replace('Unique wallets:', '').trim()) || 0;
      }
      // Section headers
      else if (line.includes('POOLMANAGER DISTRIBUTION')) {
        section = 'pmDistribution';
      }
      else if (line.includes('TOP BUYERS')) {
        section = 'topBuyers';
      }
      else if (line.includes('EARLY BUYERS')) {
        section = 'earlyBuyers';
      }
      // Data lines starting with "  0x"
      else if (line.match(/^\s+0x[a-f0-9]+\s+\|/)) {
        const parts = line.trim().split('|');
        if (parts.length >= 3) {
          const wallet = parts[0].trim();
          const amount = parseFloat(parts[1].trim().replace(/,/g, '')) || 0;
          const blockMatch = parts[2].match(/blk=(\d+)/);
          const block = blockMatch ? parseInt(blockMatch[1]) : 0;
          
          const entry = { wallet, amount, block };
          
          if (section === 'pmDistribution') scan.pmDistribution.push(entry);
          else if (section === 'topBuyers') scan.topBuyers.push(entry);
          else if (section === 'earlyBuyers') scan.earlyBuyers.push(entry);
        }
      }
    }

    return res.status(200).json(scan);
  } catch (error) {
    console.error('Scan error:', error.message);
    return res.status(500).json({ 
      error: error.message,
      stdout: error.stdout?.substring(0, 1000) || undefined 
    });
  }
}
