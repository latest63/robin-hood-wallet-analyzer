import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useWallet } from '../context/WalletContext';
import { supabase, startMonitor } from '../lib/supabase';
import { Loader2, ArrowLeft, Bell, ExternalLink, Copy, Check, Wallet, TrendingUp, Clock } from 'lucide-react';

export default function ClusterDetail() {
  const { id } = useParams();
  const { address } = useWallet();
  const [cluster, setCluster] = useState(null);
  const [wallets, setWallets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [webhookUrl, setWebhookUrl] = useState('');
  const [monitoring, setMonitoring] = useState(false);
  const [copied, setCopied] = useState(null);

  useEffect(() => {
    if (address && id) {
      loadCluster();
    }
  }, [address, id]);

  const loadCluster = async () => {
    setLoading(true);
    try {
      const { data: clusterData, error: clusterError } = await supabase
        .from('clusters')
        .select('*')
        .eq('id', id)
        .eq('user_wallet', address.toLowerCase())
        .single();

      if (clusterError) throw clusterError;

      const { data: walletsData, error: walletsError } = await supabase
        .from('cluster_wallets')
        .select('*')
        .eq('cluster_id', id)
        .order('profit', { ascending: false });

      if (walletsError) throw walletsError;

      setCluster(clusterData);
      setWallets(walletsData || []);
    } catch (error) {
      console.error('Error loading cluster:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleStartMonitor = async () => {
    if (!webhookUrl) {
      alert('Please enter a Discord webhook URL');
      return;
    }

    setMonitoring(true);
    try {
      await startMonitor(parseInt(id), address, webhookUrl);
      alert('Monitor started! You will receive alerts when cluster wallets buy.');
      setWebhookUrl('');
    } catch (error) {
      console.error('Error starting monitor:', error);
      alert('Failed to start monitor: ' + error.message);
    } finally {
      setMonitoring(false);
    }
  };

  const copyAddress = (addr) => {
    navigator.clipboard.writeText(addr);
    setCopied(addr);
    setTimeout(() => setCopied(null), 2000);
  };

  const totalProfit = wallets.reduce((sum, w) => sum + (w.profit || 0), 0);
  const avgPnl = wallets.length > 0 ? wallets.reduce((sum, w) => sum + (w.pnl_pct || 0), 0) / wallets.length : 0;

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '80px 0' }}>
        <Loader2 size={28} className="spin" style={{ color: 'var(--primary)' }} />
      </div>
    );
  }

  if (!cluster) {
    return (
      <div className="empty-state">
        <p>Cluster not found</p>
        <Link to="/dashboard" className="btn btn-secondary mt-4">
          <ArrowLeft size={16} />
          Back to Dashboard
        </Link>
      </div>
    );
  }

  return (
    <div className="fade-in">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Link to="/dashboard" className="btn btn-secondary" style={{ padding: '8px 12px' }}>
            <ArrowLeft size={16} />
          </Link>
          <div>
            <h1 style={{ fontSize: 24, fontWeight: 700 }}>{cluster.name}</h1>
            {cluster.token_symbol && (
              <span className="badge badge-success mt-1">{cluster.token_symbol}</span>
            )}
          </div>
        </div>
        <a
          href={`https://robinhoodscan.com/token/${cluster.token_address}`}
          target="_blank"
          rel="noopener noreferrer"
          className="btn btn-secondary"
          style={{ padding: '8px 12px', fontSize: 13 }}
        >
          <ExternalLink size={14} />
          Explorer
        </a>
      </div>

      {/* Stats */}
      <div className="grid grid-3 mb-6">
        <div className="stat-card">
          <div className="stat-value">{wallets.length}</div>
          <div className="stat-label">
            <Wallet size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} />
            Wallets
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-value">${totalProfit.toLocaleString()}</div>
          <div className="stat-label">
            <TrendingUp size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} />
            Total Profit
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{(avgPnl * 100).toFixed(1)}%</div>
          <div className="stat-label">
            <Clock size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} />
            Avg PnL
          </div>
        </div>
      </div>

      {/* Monitor */}
      <div className="card">
        <h2 style={{ fontSize: 18, marginBottom: 8, fontWeight: 600 }}>
          <Bell size={18} style={{ verticalAlign: 'middle', marginRight: 8, color: 'var(--primary)' }} />
          Start Monitor
        </h2>
        <p className="text-sm text-muted mb-4">
          Get Discord alerts when any wallet in this cluster makes a buy
        </p>
        <div className="flex gap-3">
          <input
            type="text"
            className="input"
            placeholder="Discord Webhook URL"
            value={webhookUrl}
            onChange={(e) => setWebhookUrl(e.target.value)}
          />
          <button
            className="btn btn-primary"
            onClick={handleStartMonitor}
            disabled={monitoring}
            style={{ minWidth: 140 }}
          >
            {monitoring ? (
              <>
                <Loader2 size={16} className="spin" />
                Starting...
              </>
            ) : (
              <>
                <Bell size={16} />
                Start Monitor
              </>
            )}
          </button>
        </div>
      </div>

      {/* Wallets */}
      <div className="card mt-4">
        <div className="section-header">
          <h2 style={{ fontSize: 18, fontWeight: 600 }}>
            Cluster Wallets
            <span className="badge badge-primary ml-2">{wallets.length}</span>
          </h2>
        </div>
        
        {wallets.length === 0 ? (
          <div className="empty-state">
            <p>No wallets in this cluster</p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Wallet</th>
                  <th>Profit</th>
                  <th>PnL %</th>
                  <th>Added</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {wallets.map((wallet) => (
                  <tr key={wallet.id}>
                    <td>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm">
                          {wallet.wallet_address.slice(0, 8)}...{wallet.wallet_address.slice(-6)}
                        </span>
                        <button
                          className="btn btn-secondary"
                          style={{ padding: '4px 8px', fontSize: 12 }}
                          onClick={() => copyAddress(wallet.wallet_address)}
                          title="Copy address"
                        >
                          {copied === wallet.wallet_address ? (
                            <Check size={14} className="text-success" />
                          ) : (
                            <Copy size={14} />
                          )}
                        </button>
                      </div>
                    </td>
                    <td>
                      <span className="text-success font-bold">
                        ${wallet.profit?.toLocaleString() || 0}
                      </span>
                    </td>
                    <td>
                      <span className={(wallet.pnl_pct || 0) > 0 ? 'text-success' : 'text-danger'}>
                        {(wallet.pnl_pct * 100).toFixed(1)}%
                      </span>
                    </td>
                    <td className="text-sm text-muted">
                      {new Date(wallet.added_at).toLocaleDateString()}
                    </td>
                    <td>
                      <a
                        href={`https://robinhoodscan.com/address/${wallet.wallet_address}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn btn-secondary"
                        style={{ padding: '6px 8px' }}
                        title="View on explorer"
                      >
                        <ExternalLink size={14} />
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
