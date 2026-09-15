import { useState, useEffect } from 'react';
import { useWallet } from '../context/WalletContext';
import { getUserClusters, getUserMonitors, deleteCluster, stopMonitor } from '../lib/supabase';
import { Loader2, Plus, Trash2, Bell, BellOff, ExternalLink } from 'lucide-react';
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

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '80px 0' }}>
        <Loader2 size={28} className="spin" style={{ color: 'var(--primary)' }} />
      </div>
    );
  }

  return (
    <div className="fade-in">
      <div className="flex items-center justify-between mb-4">
        <h1 style={{ fontSize: 24, fontWeight: 700 }}>Dashboard</h1>
        <Link to="/scan" className="btn btn-primary">
          <Plus size={16} />
          New Cluster
        </Link>
      </div>

      {/* Stats */}
      <div className="grid grid-3 mb-4">
        <div className="stat-card">
          <div className="stat-value">{clusters.length}</div>
          <div className="stat-label">Clusters</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">
            {clusters.reduce((sum, c) => sum + (c.cluster_wallets?.length || 0), 0)}
          </div>
          <div className="stat-label">Total Wallets</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{monitors.filter(m => m.active).length}</div>
          <div className="stat-label">Active Monitors</div>
        </div>
      </div>

      {/* Clusters */}
      <div className="card">
        <h2 style={{ fontSize: 18, marginBottom: 16 }}>Your Clusters</h2>
        
        {clusters.length === 0 ? (
          <div className="empty-state">
            <p>No clusters yet</p>
            <p className="text-sm text-muted mt-2">
              Scan a token to find profitable traders and build your first cluster
            </p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {clusters.map(cluster => (
              <div key={cluster.id} className="wallet-card">
                <div className="flex items-center justify-between">
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 15 }}>{cluster.name}</div>
                    <div className="text-sm text-muted mt-1">
                      {cluster.token_symbol && (
                        <span className="badge badge-success" style={{ marginRight: 8 }}>
                          {cluster.token_symbol}
                        </span>
                      )}
                      {cluster.cluster_wallets?.length || 0} wallets
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Link
                      to={`/cluster/${cluster.id}`}
                      className="btn btn-secondary"
                      style={{ padding: '8px 12px', fontSize: 13 }}
                    >
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
        <h2 style={{ fontSize: 18, marginBottom: 16 }}>Active Monitors</h2>
        
        {monitors.length === 0 ? (
          <div className="empty-state">
            <p>No active monitors</p>
            <p className="text-sm text-muted mt-2">
              Start a monitor to get Discord alerts when cluster wallets buy
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
                    <div className="text-sm text-muted mt-1">
                      {monitor.clusters?.token_symbol && (
                        <span className="badge badge-success" style={{ marginRight: 8 }}>
                          {monitor.clusters.token_symbol}
                        </span>
                      )}
                      <span className={monitor.active ? 'text-success' : 'text-danger'}>
                        {monitor.active ? '● Active' : '● Stopped'}
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
