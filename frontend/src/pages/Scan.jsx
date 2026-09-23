import { useState } from 'react';
import { useWallet } from '../context/WalletContext';
import { scanToken } from '../lib/gmgn';
import { createCluster, addWalletsToCluster } from '../lib/supabase';
import { useNavigate } from 'react-router-dom';
import { Loader2, Search, Check, ExternalLink } from 'lucide-react';

export default function Scan() {
  const { address } = useWallet();
  const navigate = useNavigate();
  const [tokenAddress, setTokenAddress] = useState('');
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState(null);
  const [tokenInfo, setTokenInfo] = useState(null);
  const [traders, setTraders] = useState([]);
  const [selectedTraders, setSelectedTraders] = useState(new Set());
  const [clusterName, setClusterName] = useState('');
  const [saving, setSaving] = useState(false);

  const handleScan = async () => {
    if (!tokenAddress || !tokenAddress.startsWith('0x')) {
      setError('Please enter a valid token address');
      return;
    }

    setScanning(true);
    setError(null);
    setTokenInfo(null);
    setTraders([]);
    setSelectedTraders(new Set());

    try {
      // Use RPC-based scan via API endpoint
      const resp = await fetch(`/api/scan?address=${tokenAddress}`);
      const result = await resp.json();
      
      if (result.error) {
        throw new Error(result.error);
      }

      // Transform data for display
      setTokenInfo({
        name: result.token?.substring(2, 10) + '...' || result.token,
        symbol: 'TOKEN',
        price: null,
        holders_count: result.uniqueWallets || 0
      });

      // Use pmDistribution and earlyBuyers from API
      const allBuyers = [
        ...result.pmDistribution || [],
        ...result.earlyBuyers || []
      ].filter((v, i, a) => a.findIndex(t => t.wallet === v.wallet) === i);

      const traders = allBuyers.map(b => ({
        wallet: b.wallet,
        profit: b.amount > 1000000 ? b.amount - 1000000 : 0,
        pnl_pct: b.amount > 1000000 ? 0.5 : 0,
        buys: 1,
        tags: result.pmDistribution?.some(pm => pm.wallet === b.wallet) ? ['PM'] : [],
        selected: false
      }));

      setTraders(traders);
      
      // Auto-select profitable traders
      const autoSelected = new Set();
      traders.forEach((t, i) => {
        if (t.profit > 1000 || t.tags.includes('PM')) autoSelected.add(i);
      });
      setSelectedTraders(autoSelected);
    } catch (err) {
      console.error('Scan error:', err);
      setError(err.message || 'Failed to scan token');
    } finally {
      setScanning(false);
    }
  };

  const toggleTrader = (index) => {
    const newSelected = new Set(selectedTraders);
    if (newSelected.has(index)) {
      newSelected.delete(index);
    } else {
      newSelected.add(index);
    }
    setSelectedTraders(newSelected);
  };

  const selectAll = () => {
    const all = new Set(traders.map((_, i) => i));
    setSelectedTraders(all);
  };

  const selectProfitable = () => {
    const profitable = new Set();
    traders.forEach((t, i) => {
      if (t.profit > 1000) profitable.add(i);
    });
    setSelectedTraders(profitable);
  };

  const handleSaveCluster = async () => {
    if (!clusterName.trim()) {
      setError('Please enter a cluster name');
      return;
    }

    if (selectedTraders.size === 0) {
      setError('Please select at least one trader');
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const cluster = await createCluster(address, {
        name: clusterName,
        token_address: tokenAddress,
        token_symbol: tokenInfo?.symbol || ''
      });

      const selectedWallets = Array.from(selectedTraders).map(i => ({
        wallet: traders[i].wallet,
        profit: traders[i].profit,
        pnl_pct: traders[i].pnl_pct
      }));

      await addWalletsToCluster(cluster.id, selectedWallets);
      navigate('/dashboard');
    } catch (err) {
      console.error('Save error:', err);
      setError(err.message || 'Failed to save cluster');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fade-in">
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 20 }}>Scan Token</h1>

      {/* Search */}
      <div className="card">
        <div className="flex gap-3">
          <input
            type="text"
            className="input"
            placeholder="Enter token contract address (0x...)"
            value={tokenAddress}
            onChange={(e) => setTokenAddress(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleScan()}
          />
          <button
            className="btn btn-primary"
            onClick={handleScan}
            disabled={scanning}
            style={{ minWidth: 120 }}
          >
            {scanning ? (
              <>
                <Loader2 size={16} className="spin" />
                Scanning...
              </>
            ) : (
              <>
                <Search size={16} />
                Scan
              </>
            )}
          </button>
        </div>
      </div>

      {error && (
        <div className="error-msg mt-3">{error}</div>
      )}

      {/* Token Info */}
      {tokenInfo && (
        <div className="card mt-3 fade-in">
          <div className="flex items-center justify-between">
            <div>
              <h2 style={{ fontSize: 20, fontWeight: 700 }}>
                {tokenInfo.name} ({tokenInfo.symbol})
              </h2>
              <div className="text-sm text-muted mt-1">
                Price: ${tokenInfo.price || 'N/A'} • 
                Holders: {tokenInfo.holders_count || 'N/A'}
              </div>
            </div>
            <a
              href={`https://robinhoodscan.com/token/${tokenAddress}`}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-secondary"
              style={{ padding: '8px 12px', fontSize: 13 }}
            >
              <ExternalLink size={14} />
              Explorer
            </a>
          </div>
        </div>
      )}

      {/* Traders List */}
      {traders.length > 0 && (
        <div className="card mt-3 fade-in">
          <div className="flex items-center justify-between mb-4">
            <h2 style={{ fontSize: 18 }}>
              Profitable Traders ({selectedTraders.size} selected)
            </h2>
            <div className="flex gap-2">
              <button className="btn btn-secondary" onClick={selectAll} style={{ padding: '8px 12px', fontSize: 13 }}>
                Select All
              </button>
              <button className="btn btn-secondary" onClick={selectProfitable} style={{ padding: '8px 12px', fontSize: 13 }}>
                Select Profitable
              </button>
            </div>
          </div>

          {/* Cluster Name Input */}
          <div className="flex gap-3 mb-4">
            <input
              type="text"
              className="input"
              placeholder="Enter cluster name (e.g., MEME Whales)"
              value={clusterName}
              onChange={(e) => setClusterName(e.target.value)}
            />
            <button
              className="btn btn-primary"
              onClick={handleSaveCluster}
              disabled={saving || selectedTraders.size === 0}
              style={{ minWidth: 160 }}
            >
              {saving ? (
                <>
                  <Loader2 size={16} className="spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Check size={16} />
                  Save Cluster ({selectedTraders.size})
                </>
              )}
            </button>
          </div>

          {/* Traders Table */}
          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 50 }}></th>
                  <th>Wallet</th>
                  <th>Profit</th>
                  <th>PnL %</th>
                  <th>Buys</th>
                </tr>
              </thead>
              <tbody>
                {traders.map((trader, i) => (
                  <tr
                    key={i}
                    onClick={() => toggleTrader(i)}
                    style={{ cursor: 'pointer', background: selectedTraders.has(i) ? 'rgba(99, 102, 241, 0.05)' : 'transparent' }}
                  >
                    <td>
                      <input
                        type="checkbox"
                        className="checkbox"
                        checked={selectedTraders.has(i)}
                        onChange={() => toggleTrader(i)}
                      />
                    </td>
                    <td>
                      <span className="font-mono text-sm">
                        {trader.wallet.slice(0, 6)}...{trader.wallet.slice(-4)}
                      </span>
                    </td>
                    <td>
                      <span className="text-success font-bold">
                        ${trader.profit.toLocaleString()}
                      </span>
                    </td>
                    <td>
                      <span className={trader.pnl_pct > 0 ? 'text-success' : 'text-danger'}>
                        {(trader.pnl_pct * 100).toFixed(1)}%
                      </span>
                    </td>
                    <td>{trader.buys}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Empty State */}
      {!scanning && !tokenInfo && (
        <div className="empty-state mt-4">
          <Search size={48} style={{ color: 'var(--text-dim)', marginBottom: 16 }} />
          <p>Enter a token address to find profitable traders</p>
          <p className="text-sm text-muted mt-2">
            Build clusters from top traders and get alerts when they buy
          </p>
        </div>
      )}
    </div>
  );
}
