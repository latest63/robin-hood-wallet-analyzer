import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWallet } from '../context/WalletContext';
import { Loader2, Scan, TrendingUp, Shield, BarChart3, Target, Bell, Search, Users, LineChart } from 'lucide-react';

export default function Landing() {
  const { isConnected, connectWallet, isReconnecting } = useWallet();
  const navigate = useNavigate();
  const [connecting, setConnecting] = useState(false);

  const handleConnect = async () => {
    try {
      setConnecting(true);
      await connectWallet();
      navigate('/dashboard');
    } catch (err) {
      console.error('Connection error:', err);
    } finally {
      setConnecting(false);
    }
  };

  if (isReconnecting) {
    return (
      <div className="landing-loading">
        <Loader2 size={48} className="spin" style={{ color: 'var(--primary)' }} />
      </div>
    );
  }

  return (
    <div className="landing">
      {/* Background Effects */}
      <div className="landing-bg" />
      
      {/* Navbar */}
      <nav className="landing-navbar">
        <div className="logo">
          <img src="/logo.png" alt="FNF Radar Logo" style={{ height: 36, width: 'auto' }} />
          <span className="logo-text">
            <span className="logo-fnf">fnf</span>
            <span className="logo-radar">radar</span>
          </span>
        </div>
        
        <div className="landing-nav-links">
          <a href="#features" className="nav-link">Features</a>
          <a href="#how-it-works" className="nav-link">How It Works</a>
          {isConnected ? (
            <button className="btn btn-primary" onClick={() => navigate('/dashboard')}>
              Dashboard
            </button>
          ) : (
            <button className="btn btn-primary" onClick={handleConnect} disabled={connecting}>
              {connecting ? (
                <>
                  <Loader2 size={16} className="spin" />
                  Connecting...
                </>
              ) : (
                <>
                  <Shield size={16} />
                  Connect Wallet
                </>
              )}
            </button>
          )}
        </div>
      </nav>

      {/* Hero Section */}
      <section className="hero">
        <div className="hero-content">
          <h1 className="hero-title">
            Discover <span className="text-gradient">Early Buyers</span> on Robinhood Chain
          </h1>
          
          <p className="hero-subtitle">
            Scan any token contract to find profitable traders, analyze PoolManager distribution, and build smart watchlists. Track whales before they move.
          </p>
          
          <div className="hero-actions">
            {isConnected ? (
              <>
                <button className="btn btn-primary btn-large" onClick={() => navigate('/scan')}>
                  <Scan size={20} />
                  Start Scanning
                </button>
                <button className="btn btn-secondary btn-large" onClick={() => navigate('/dashboard')}>
                  <TrendingUp size={20} />
                  View Dashboard
                </button>
              </>
            ) : (
              <button className="btn btn-primary btn-large" onClick={handleConnect} disabled={connecting}>
                {connecting ? (
                  <>
                    <Loader2 size={20} className="spin" />
                    Connecting...
                  </>
                ) : (
                  <>
                    <Shield size={20} />
                    Connect Wallet to Get Started
                  </>
                )}
              </button>
            )}
          </div>
          
          <div className="hero-stats">
            <div className="stat">
              <div className="stat-value">Instant</div>
              <div className="stat-label">Scans</div>
            </div>
            <div className="stat-divider" />
            <div className="stat">
              <div className="stat-value">Real-time</div>
              <div className="stat-label">Data</div>
            </div>
            <div className="stat-divider" />
            <div className="stat">
              <div className="stat-value">Free</div>
              <div className="stat-label">To Use</div>
            </div>
          </div>
        </div>
        
        {/* Floating Elements */}
        <div className="floating-elements">
          <div className="float-card">
            <BarChart3 size={18} className="float-icon" />
            <div className="float-text">Track Top Buyers</div>
          </div>
          <div className="float-card">
            <Target size={18} className="float-icon" />
            <div className="float-text">PoolManager Analysis</div>
          </div>
          <div className="float-card">
            <Bell size={18} className="float-icon" />
            <div className="float-text">Real-time Alerts</div>
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section id="features" className="features">
        <h2 className="section-title">Powerful Features</h2>
        <div className="features-grid">
          <div className="feature-card">
            <Search size={32} className="feature-icon" />
            <h3>Token Scanner</h3>
            <p>Enter any contract address to discover early buyers and PoolManager distribution instantly.</p>
          </div>
          <div className="feature-card">
            <Users size={32} className="feature-icon" />
            <h3>Buyer Analysis</h3>
            <p>Identify whale wallets, track their movements, and build profitable clusters.</p>
          </div>
          <div className="feature-card">
            <LineChart size={32} className="feature-icon" />
            <h3>Portfolio Tracking</h3>
            <p>Monitor your clusters in real-time and get alerts when your tracked wallets buy.</p>
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section id="how-it-works" className="how-it-works">
        <h2 className="section-title">How It Works</h2>
        <div className="steps">
          <div className="step">
            <div className="step-number">1</div>
            <h3>Connect Wallet</h3>
            <p>Sign in with your Robinhood Chain wallet to access all features.</p>
          </div>
          <div className="step-arrow">→</div>
          <div className="step">
            <div className="step-number">2</div>
            <h3>Scan Tokens</h3>
            <p>Enter a token contract address to discover early buyers and whales.</p>
          </div>
          <div className="step-arrow">→</div>
          <div className="step">
            <div className="step-number">3</div>
            <h3>Build Clusters</h3>
            <p>Select profitable traders and save them as clusters for monitoring.</p>
          </div>
          <div className="step-arrow">→</div>
          <div className="step">
            <div className="step-number">4</div>
            <h3>Get Alerts</h3>
            <p>Receive Discord notifications when your tracked wallets make moves.</p>
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="cta">
        <h2 className="section-title">Ready to Find Early Buyers?</h2>
        <p className="cta-text">
          Join thousands of traders using FNF Radar to discover profitable opportunities on Robinhood Chain.
        </p>
        <button className="btn btn-primary btn-large" onClick={handleConnect} disabled={connecting || isReconnecting}>
          {connecting ? (
            <>
              <Loader2 size={20} className="spin" />
              Connecting...
            </>
          ) : isConnected ? (
            <>
              <Scan size={20} />
              Start Scanning Now
            </>
          ) : (
            <>
              <Shield size={20} />
              Connect Wallet & Start Scanning
            </>
          )}
        </button>
      </section>
    </div>
  );
}
