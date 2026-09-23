import { useState, useEffect } from 'react';
import { useWallet } from '../context/WalletContext';
import { getUserClusters, getUserMonitors, deleteCluster, stopMonitor } from '../lib/supabase';
import { Loader2, Plus, Trash2, Bell, BellOff, ExternalLink, TrendingUp, Users, Activity, Eye } from 'lucide-react';
import { Link } from 'react-router-dom';

export default function Dashboard() {
  const { address } = useWallet();
  const [clusters, setClusters] = useState([]);
  const [monitors, setMonitors] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (address) {
      loadData();
    }
  }, [address]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [clustersData, monitorsData] = await Promise.all([
        getUserClusters(address),
        getUserMonitors(address)
      ]);
      setClusters(clustersData);
      setMonitors(monitorsData);
    } catch (error) {
      console.error('Error loading data:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteCluster = async (clusterId) => {
    if (!confirm('Are you sure you want to delete this cluster?')) return;
    
    try {
      await deleteCluster(clusterId);
      setClusters(clusters.filter(c => c.id !== clusterId));
    } catch (error) {
      console.error('Error deleting cluster:', error);
    }
  };

  const handleStopMonitor = async (monitorId) => {
    try {
      await stopMonitor(monitorId);
      setMonitors(monitors.map(m => 
        m.id === monitorId ? { ...m, active: false } : m
      ));
    } catch (error) {
      console.error('Error stopping monitor:', error);
    }
  };

  const totalWallets = clusters.reduce((sum, c) => sum + (c.cluster_wallets?.length || 0), 0);
  const activeMonitors = monitors.filter(m => m.active).length;

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '80px 0' }}>
        <Loader2 size={28} className="spin" style={{ color: 'var(--primary)' }} />
      </div>
    );
  }

  return (
    <div className="fade-in">
      <div className="flex items-center justify-between mb-6">
        <h1 style={{ fontSize: 28, fontWeight: 800 }}>Dashboard</h1>
        <Link to="/scan" className="btn btn-primary">
          <Plus size={16} />
          New Scan
        </Link>
      </div>

      {/* Stats */}
      <div className="grid grid-3 mb-6">
        <div className="stat-card">
          <div className="stat-value">{clusters.length}</div>
          <div className="stat-label">
            <TrendingUp size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} />
            Clusters
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{totalWallets}</div>
          <div className="stat-label">
            <Users size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} />
            Total Wallets
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{activeMonitors}</div>
          <div className="stat-label">
            <Activity size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} />
            Active Monitors
          </div>
        </div>
      </div>

      {/* Clusters */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 style={{ fontSize: 18, fontWeight: 600 }}>Your Clusters</h2>
          <span className="text-sm text-muted">{clusters.length} total</span>
        </div>
        
        {clusters.length === 0 ? (
          <div className="empty-state">
            <TrendingUp size={48} style={{ color: 'var(--text-dim)', marginBottom: 16 }} />
            <p>No clusters yet</p>
            <p className="text-sm text-muted mt-2">
              Scan a token to find profitable traders and build your first cluster
            </p>
            <Link to="/scan" className="btn btn-primary mt-4">
              <Plus size={16} />
              Start Scanning
            </Link>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {clusters.map(cluster => (
              <div key={cluster.id} className="wallet-card">
                <div className="flex items-center justify-between">
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 15 }}>{cluster.name}</div>
                    <div className="text-sm text-muted mt-1 flex items-center gap-2 flex-wrap">
                      {cluster.token_symbol && (
                        <span className="badge badge-success">
                          {cluster.token_symbol}
                        </span>
                      )}
                      <span className="flex items-center gap-1">
                        <Users size={12} />
                        {cluster.cluster_wallets?.length || 0} wallets
                      </span>
                      <span className="font-mono text-xs text-dim">
                        {cluster.token_address?.slice(0, 8)}...{cluster.token_address?.slice(-6)}
                      </span>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Link
                      to={`/cluster/${cluster.id}`}
                      className="btn btn-secondary"
                      style={{ padding: '8px 12px', fontSize: 13 }}
                    >
                      <Eye size={14} />
                      View
                    </Link>
                    <button
                      className="btn btn-danger"
                      style={{ padding: '8px 12px', fontSize: 13 }}
                      onClick={() => handleDeleteCluster(cluster.id)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Monitors */}
      <div className="card mt-4">
        <div className="flex items-center justify-between mb-4">
          <h2 style={{ fontSize: 18, fontWeight: 600 }}>Active Monitors</h2>
          <span className="text-sm text-muted">{monitors.length} total</span>
        </div>
        
        {monitors.length === 0 ? (
          <div className="empty-state" style={{ padding: '40px 20px' }}>
            <BellOff size={40} style={{ color: 'var(--text-dim)', marginBottom: 12 }} />
            <p>No active monitors</p>
            <p className="text-sm text-muted mt-2">
              Create a cluster and start monitoring to get alerts when wallets buy
            </p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {monitors.map(monitor => (
              <div key={monitor.id} className="wallet-card">
                <div className="flex items-center justify-between">
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 15 }}>
                      {monitor.clusters?.name || 'Unknown Cluster'}
                    </div>
                    <div className="text-sm text-muted mt-1 flex items-center gap-2">
                      {monitor.clusters?.token_symbol && (
                        <span className="badge badge-success">
                          {monitor.clusters.token_symbol}
                        </span>
                      )}
                      <span className={monitor.active ? 'text-success' : 'text-danger'}>
                        {monitor.active ? (
                          <span className="flex items-center gap-1">
                            <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor', display: 'inline-block' }} />
                            Active
                          </span>
                        ) : 'Stopped'}
                      </span>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    {monitor.active && (
                      <button
                        className="btn btn-secondary"
                        style={{ padding: '8px 12px', fontSize: 13 }}
                        onClick={() => handleStopMonitor(monitor.id)}
                      >
                        <BellOff size={14} />
                        Stop
                      </button>
                    )}
                    <a
                      href={monitor.webhook_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn btn-secondary"
                      style={{ padding: '8px 12px', fontSize: 13 }}
                    >
                      <ExternalLink size={14} />
                      Webhook
                    </a>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
