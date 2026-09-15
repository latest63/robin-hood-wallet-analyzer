import { useState, useEffect } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import { useWallet } from '../context/WalletContext';
import { getOrCreateUser } from '../lib/supabase';
import { Loader2, Wallet, Shield, Zap } from 'lucide-react';

export default function Auth() {
  const { isAuthenticated, connectWallet, address, isReconnecting } = useWallet();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (isAuthenticated && address) {
      setLoading(true);
      getOrCreateUser(address)
        .then(() => {
          navigate('/dashboard');
        })
        .catch(err => {
          console.error('Auth error:', err);
          setError('Failed to authenticate. Please try again.');
        })
        .finally(() => setLoading(false));
    }
  }, [isAuthenticated, address, navigate]);

  if (isReconnecting) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '80px 0' }}>
        <Loader2 size={28} className="spin" style={{ color: 'var(--primary)' }} />
      </div>
    );
  }

  if (isAuthenticated) {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    <div style={{ maxWidth: 480, margin: '60px auto', padding: '0 20px' }}>
      <div style={{ textAlign: 'center', marginBottom: 40 }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>⚡</div>
        <h1 style={{ fontSize: 28, fontWeight: 800, marginBottom: 8 }}>
          Welcome to{' '}
          <span style={{
            background: 'linear-gradient(135deg, var(--primary), #a855f7)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent'
          }}>
            FNF Radar
          </span>
        </h1>
        <p style={{ color: 'var(--text-muted)', fontSize: 16 }}>
          Connect your wallet to build profitable clusters and get buy alerts
        </p>
      </div>

      {error && (
        <div className="error-msg" style={{ marginBottom: 20 }}>
          {error}
        </div>
      )}

      <div className="card" style={{ textAlign: 'center', padding: 40 }}>
        <Wallet size={48} style={{ color: 'var(--primary)', marginBottom: 20 }} />
        
        <h2 style={{ fontSize: 20, marginBottom: 12 }}>Connect Your Wallet</h2>
        <p style={{ color: 'var(--text-muted)', marginBottom: 24, fontSize: 14 }}>
          Sign in with your Ethereum wallet to access the dashboard
        </p>

        <button
          className="btn btn-primary"
          onClick={connectWallet}
          disabled={loading}
          style={{ width: '100%', padding: '14px 24px', fontSize: 16 }}
        >
          {loading ? (
            <>
              <Loader2 size={20} className="spin" />
              Connecting...
            </>
          ) : (
            <>
              <Wallet size={20} />
              Connect Wallet
            </>
          )}
        </button>

        <div style={{ marginTop: 24, display: 'flex', justifyContent: 'center', gap: 32 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-dim)', fontSize: 13 }}>
            <Shield size={16} />
            <span>Secure</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-dim)', fontSize: 13 }}>
            <Zap size={16} />
            <span>Instant</span>
          </div>
        </div>
      </div>

      <div style={{ textAlign: 'center', marginTop: 24 }}>
        <p style={{ color: 'var(--text-dim)', fontSize: 13 }}>
          Supported wallets: MetaMask, Rainbow, WalletConnect, Coinbase Wallet
        </p>
      </div>
    </div>
  );
}
