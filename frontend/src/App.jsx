import { BrowserRouter, Routes, Route, Link, Navigate, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider, createConfig, http, createStorage } from "wagmi";
import { mainnet } from "wagmi/chains";
import { RainbowKitProvider, ConnectButton, getDefaultWallets } from "@rainbow-me/rainbowkit";
import "@rainbow-me/rainbowkit/styles.css";
import { useState } from "react";
import { Menu, X, Loader2 } from "lucide-react";
import WalletProvider, { useWallet } from "./context/WalletContext";
import Auth from "./pages/Auth";
import Dashboard from "./pages/Dashboard";
import Scan from "./pages/Scan";
import ClusterDetail from "./pages/ClusterDetail";
import "./index.css";

// Robin Hood Chain configuration
const robinhoodChain = {
  id: 4663,
  name: "Robin Hood Chain",
  network: "robinhood",
  nativeCurrency: {
    decimals: 18,
    name: "ETH",
    symbol: "ETH",
  },
  rpcUrls: {
    public: { http: ["https://rpc.mainnet.chain.robinhood.com"] },
    default: { http: ["https://rpc.mainnet.chain.robinhood.com"] },
  },
  blockExplorers: {
    default: { name: "Robin Hood Scan", url: "https://robinhoodscan.com" },
  },
};

const chains = [robinhoodChain, mainnet];

const { connectors } = getDefaultWallets({
  appName: "FNF Radar",
  projectId: "7dbda9b31e7da7cb396ca5a5ae2f668e", // WalletConnect project ID (reuse from ecosystem guardian)
  chains,
});

const config = createConfig({
  chains: chains,
  transports: {
    [robinhoodChain.id]: http(),
    [mainnet.id]: http(),
  },
  connectors,
  storage: createStorage({ storage: window.localStorage }),
  ssr: false,
});

const queryClient = new QueryClient();

function ProtectedRoute({ children }) {
  const { isConnected, isReconnecting } = useWallet();
  const location = useLocation();

  if (isReconnecting) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "80px 0" }}>
        <Loader2 size={28} className="spin" style={{ color: "var(--primary)" }} />
      </div>
    );
  }
  
  if (!isConnected) {
    return (
      <Navigate
        to={`/auth?next=${encodeURIComponent(location.pathname)}`}
        replace
      />
    );
  }
  return children;
}

function Navbar() {
  const [open, setOpen] = useState(false);
  const location = useLocation();

  const isAuth = location.pathname === "/auth";
  const close = () => setOpen(false);

  return (
    <nav className="navbar">
      <Link to="/" className="logo" onClick={close}>
        <span className="logo-fnf">fnf</span>
        <span className="logo-radar">radar</span>
      </Link>

      {!isAuth && (
        <>
          <button className="menu-toggle" onClick={() => setOpen(!open)} style={{ background: 'none', border: 'none', color: 'var(--text)', cursor: 'pointer' }}>
            {open ? <X size={20} /> : <Menu size={20} />}
          </button>

          <div className={`nav-links ${open ? "open" : ""}`}>
            <Link to="/dashboard" onClick={close}>Dashboard</Link>
            <Link to="/scan" onClick={close}>Scan</Link>

            <div className="nav-connect-widget">
              <ConnectButton
                accountStatus="avatar"
                chainStatus="icon"
                showBalance={false}
              />
            </div>
          </div>
        </>
      )}
    </nav>
  );
}

export default function App() {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider>
          <WalletProvider>
            <BrowserRouter>
              <div className="app">
                <Navbar />
                <main className="main">
                  <Routes>
                    <Route path="/" element={<Navigate to="/dashboard" replace />} />
                    <Route path="/auth" element={<Auth />} />
                    <Route path="/dashboard" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
                    <Route path="/scan" element={<ProtectedRoute><Scan /></ProtectedRoute>} />
                    <Route path="/cluster/:id" element={<ProtectedRoute><ClusterDetail /></ProtectedRoute>} />
                    <Route path="*" element={<Navigate to="/dashboard" replace />} />
                  </Routes>
                </main>
              </div>
            </BrowserRouter>
          </WalletProvider>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
