import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWallet } from '../context/WalletContext';
import { Loader2 } from 'lucide-react';

export default function Auth() {
  const { isAuthenticated, address } = useWallet();
  const navigate = useNavigate();

  // Navigate immediately when authenticated - no need to wait for user record
  useEffect(() => {
    if (isAuthenticated && address) {
      navigate('/dashboard', { replace: true });
    }
  }, [isAuthenticated, address, navigate]);

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
      <div style={{ textAlign: 'center' }}>
        <Loader2 size={40} className="spin" style={{ color: 'var(--primary)', marginBottom: 16 }} />
        <p style={{ color: 'var(--text-muted)' }}>Connecting...</p>
      </div>
    </div>
  );
}
