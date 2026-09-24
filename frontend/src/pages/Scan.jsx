import { useState } from 'react';
import { useWallet } from '../context/WalletContext';
import { createCluster, addWalletsToCluster } from '../lib/supabase';
import { useNavigate } from 'react-router-dom';
import { Loader2, Search, Check, ExternalLink, Copy, TrendingUp, Users, Activity, TestTube, Globe } from 'lucide-react';

export default function Scan() {
  const { address } = useWallet();
  const navigate = useNavigate();
  const [tokenAddress, setTokenAddress] = useState('');
  const [network, setNetwork] = useState('mainnet'); // 'mainnet' | 'testnet'
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState('');
  const [tokenInfo, setTokenInfo] = useState(null);
  const [earlyBuyers, setEarlyBuyers] = useState([]);
  const [selectedTraders, setSelectedTraders] = useState(new Set());
  const [clusterName, setClusterName] = useState('');
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(null);

  const handleScan = async () => {
    if (!tokenAddress || !tokenAddress.startsWith('0x')) {
      setError('Please enter a valid token address (0x...)');
      return;
    }

    setScanning(true);
    setError(null);
    setProgress('Initializing scan...');
    setTokenInfo(null);
    setEarlyBuyers([]);
    setSelectedTraders(new Set());

    try {
      const resp = await fetch(`/api/scan?address=${tokenAddress}&network=${network}`);
      const result = await resp.json();
      
      if (result.error) {
        throw new Error(result.error);
      }

      setProgress('Parsing results...');

      // Use real token name and symbol from API if available, otherwise truncate address
      const rawName = result.tokenName?.replace(/[\x00-\x1F]/g, '').trim();
      const rawSymbol = result.tokenSymbol?.replace(/[\x00-\x1F]/g, '').trim();
      const tokenName = rawName || result.token?.substring(2, 10) + '...';
      const tokenSymbol = rawSymbol || 'TOKEN';
      const isTestnet = result.network === 'testnet';

      setTokenInfo({
        name: tokenName,
        symbol: tokenSymbol,
        price: null,
        holders_count: result.uniqueWallets || 0,
        totalTransfers: result.totalTransfers || 0,
        address: result.token,
        network: result.network
      });

      const earlyData = result.earlyBuyers || [];

      setEarlyBuyers(earlyData.map(item => ({
        wallet: item.wallet,
        amount: item.amount,
        block: item.block,
        timestamp: item.timestamp
      })));

      // Auto-select all early buyers
      const autoSelected = new Set();
      earlyData.forEach((_, i) => autoSelected.add(i));
      setSelectedTraders(autoSelected);

    } catch (err) {
      console.error('Scan error:', err);
      setError(err.message || 'Failed to scan token');
    } finally {
      setScanning(false);
      setProgress('');
    }
  };

  const toggleTrader = (index) => {
    const key = `early-${index}`;
    const newSelected = new Set(selectedTraders);
    if (newSelected.has(key)) {
      newSelected.delete(key);
    } else {
      newSelected.add(key);
    }
    setSelectedTraders(newSelected);
  };

  const copyAddress = (addr) => {
    navigator.clipboard.writeText(addr);
    setCopied(addr);
    setTimeout(() => setCopied(null), 2000);
  };

  const formatAmount = (amount) => {
    if (!amount) return '0';
    const num = parseFloat(amount);
    if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
    if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
    if (num >= 1e3) return (num / 1e3).toFixed(2) + 'K';
    return num.toFixed(2);
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

      const selectedWallets = [];
      selectedTraders.forEach(key => {
        const [type, idx] = key.split('-');
        const list = type === 'early' ? earlyBuyers : earlyBuyers;
        const wallet = list[parseInt(idx)];
        if (wallet) {
          selectedWallets.push({
            wallet: wallet.wallet,
            profit: wallet.amount > 1000000 ? wallet.amount - 1000000 : 0,
            pnl_pct: wallet.amount > 1000000 ? 0.5 : 0
          });
        }
      });

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
      <div className="flex items-center justify-between mb-6">
        <h1 style={{ fontSize: 28, fontWeight: 800 }}>Token Scanner</h1>

        {/* Network Toggle */}
        <div className="network-toggle">
          <button
            className={`network-btn ${network === 'mainnet' ? 'active' : ''}`}
            onClick={() => setNetwork('mainnet')}
          >
            <Globe size={14} />
            Mainnet
          </button>
          <button
            className={`network-btn ${network === 'testnet' ? 'active' : ''}`}
            onClick={() => setNetwork('testnet')}
          >
            <TestTube size={14} />
            Testnet
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="search-box">
        <div className="input-group">
          <input
            type="text"
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

      {progress && (
        <div className="progress fade-in">{progress}</div>
      )}

      {error && (
        <div className="error-msg mt-3 fade-in">{error}</div>
      )}

      {/* Token Info */}
      {tokenInfo && (
        <div className="token-banner fade-in card-glow">
          <div>
            <h3>{tokenInfo.name} ({tokenInfo.symbol})</h3>
            <div className="text-sm text-muted mt-1 font-mono" style={{ fontSize: 12 }}>
              {tokenInfo.address}
            </div>
          </div>
          <div className="flex gap-3 flex-wrap items-center">
            <span className={`badge ${tokenInfo.network === 'testnet' ? 'badge-warning' : 'badge-primary'}`}>
              {tokenInfo.network === 'testnet' ? <TestTube size={12} /> : <Globe size={12} />}
              {tokenInfo.network === 'testnet' ? 'Testnet' : 'Mainnet'}
            </span>
            <span className="badge badge-primary">
              <Users size={12} />
              {(tokenInfo.holders_count || tokenInfo.holdersCount || 0)} Holders
            </span>
            <span className="badge badge-warning">
              <Activity size={12} />
              {tokenInfo.totalTransfers} Transfers
            </span>
            <a
              href={`https://${tokenInfo.network === 'testnet' ? 'explorer.testnet.chain.robinhood.com/address' : 'robinhoodchain.blockscout.com/address'}?address=${tokenInfo.address}`}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-secondary"
              style={{ padding: '8px 12px', fontSize: 13, whiteSpace: 'nowrap', flexShrink: 0 }}
            >
              <ExternalLink size={14} />
              Explorer
            </a>
          </div>
        </div>
      )}

      {/* Early Buyers */}
      {earlyBuyers.length > 0 && (
        <div className="card fade-in">
          <div className="section-header">
            <h2>
              <TrendingUp size={18} className="text-success" />
              Early Buyers
              <span className="badge badge-success ml-2">{earlyBuyers.length}</span>
            </h2>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 50 }}></th>
                  <th>Rank</th>
                  <th>Wallet Address</th>
                  <th>Amount Received</th>
                  <th>Block</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {earlyBuyers.map((wallet, i) => (
                  <tr
                    key={i}
                    onClick={() => toggleTrader(i)}
                    style={{ 
                      cursor: 'pointer',
                      background: selectedTraders.has(`early-${i}`) ? 'rgba(16, 185, 129, 0.08)' : 'transparent'
                    }}
                  >
                    <td>
                      <input
                        type="checkbox"
                        className="checkbox"
                        checked={selectedTraders.has(`early-${i}`)}
                        onChange={() => toggleTrader(i)}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </td>
                    <td>
                      <span className="text-dim text-xs">#{i + 1}</span>
                    </td>
                    <td>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm truncate" style={{ maxWidth: 140 }}>
                          {wallet.wallet.slice(0, 8)}...{wallet.wallet.slice(-6)}
                        </span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            copyAddress(wallet.wallet);
                          }}
                          className="btn btn-secondary"
                          style={{ padding: '4px 8px', fontSize: 12 }}
                        >
                          {copied === wallet.wallet ? <Check size={12} className="text-success" /> : <Copy size={12} />}
                        </button>
                      </div>
                    </td>
                    <td>
                      <span className="text-success font-bold">
                        {formatAmount(wallet.amount)}
                      </span>
                    </td>
                    <td className="text-sm text-muted">
                      #{parseInt(wallet.block).toLocaleString()}
                    </td>
                    <td className="text-sm text-muted">
                      {wallet.timestamp ? new Date(wallet.timestamp).toLocaleTimeString() : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Action Bar */}
      {earlyBuyers.length > 0 && (
        <div className="card fade-in mt-4">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 style={{ fontSize: 18, fontWeight: 600 }}>
                Create Cluster
              </h2>
              <p className="text-sm text-muted mt-1">
                {selectedTraders.size} traders selected
              </p>
            </div>
          </div>

          <div className="flex gap-3">
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
              style={{ minWidth: 180 }}
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
        </div>
      )}

      {/* Empty State */}
      {!scanning && !tokenInfo && (
        <div className="empty-state mt-8 fade-in">
          <Search size={48} style={{ color: 'var(--text-dim)', marginBottom: 16 }} />
          <p style={{ fontSize: 16, color: 'var(--text)' }}>Scan any token on Robin Hood Chain</p>
          <p className="text-sm text-muted mt-2">
            Enter a contract address to discover early buyers
          </p>
        </div>
      )}
    </div>
  );
}
