import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useWallet } from '../context/WalletContext';
import { supabase, startMonitor } from '../lib/supabase';
import { Loader2, ArrowLeft, Bell, ExternalLink, Copy, Check } from 'lucide-react';

export default function ClusterDetail() {
  const { id } = useParams();
  const { address } = useWallet();
  const [cluster, setCluster] = useState(null);
  const [wallets, setWallets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [webhookUrl, setWebhookUrl] = useState('');
  const [monitoring, setMonitoring] = useState(false);
  const [copied, setCopied] = useState(false);

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
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <Link to="/dashboard" className="btn btn-secondary" style={{ padding: '8px 12px' }}>
            <ArrowLeft size={16} />
          </Link>
          <h1 style={{ fontSize: 24, fontWeight: 700 }}>{cluster.name}</h1>
        </div>
        {cluster.token_symbol && (
          <span className="badge badge-success">{cluster.token_symbol}</span>
        )}
      </div>

      {/* Stats */}
      <div className="grid grid-3 mb-4">
        <div className="stat-card">
          <div className="stat-value">{wallets.length}</div>
          <div className="stat-label">Wallets</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">
            ${wallets.reduce((sum, w) => sum + (w.profit || 0), 0).toLocaleString()}
          </div>
          <div className="stat-label">Total Profit</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">
            {cluster.token_address ? cluster.token_address.slice(0, 6) + '...' : 'N/A'}
          </div>
          <div className="stat-label">Token</div>
        </div>
      </div>

      {/* Monitor */}
      <div className="card">
        <h2 style={{ fontSize: 18, marginBottom: 16 }}>
          <Bell size={18} style={{ verticalAlign: 'middle', marginRight: 8 }} />
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
        <h2 style={{ fontSize: 18, marginBottom: 16 }}>Cluster Wallets</h2>
        
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
                {wallets.map((wallet, i) => (
                  <tr key={wallet.id}>
                    <td>
                      <span className="font-mono text-sm">
                        {wallet.wallet_address.slice(0, 6)}...{wallet.wallet_address.slice(-4)}
                      </span>
                    </td>
                    <td>
                      <span className="text-success font-bold">
                        ${(wallet.profit || 0).toLocaleString()}
                      </span>
                    </td>
                    <td>
                      <span className={(wallet.pnl_pct || 0) > 0 ? 'text-success' : 'text-danger'}>
                        {((wallet.pnl_pct || 0) * 100).toFixed(1)}%
                      </span>
                    </td>
                    <td className="text-sm text-muted">
                      {new Date(wallet.added_at).toLocaleDateString()}
                    </td>
                    <td>
                      <div className="flex gap-2">
                        <button
                          className="btn btn-secondary"
                          style={{ padding: '6px 8px' }}
                          onClick={() => copyAddress(wallet.wallet_address)}
                          title="Copy address"
                        >
                          {copied === wallet.wallet_address ? (
                            <Check size={14} className="text-success" />
                          ) : (
                            <Copy size={14} />
                          )}
                        </button>
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
                      </div>
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
