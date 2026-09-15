import { createContext, useContext, useCallback, useMemo } from "react";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";

const WalletContext = createContext(null);

export const useWalletAuth = () => {
  const { address, isConnected, chain, connector, status } = useAccount();
  const { connect, connectors } = useConnect();
  const { openConnectModal } = useConnectModal();
  const { disconnect } = useDisconnect();

  const isReconnecting = status === "reconnecting" || status === "connecting";

  const connectWallet = useCallback(() => {
    if (openConnectModal) {
      openConnectModal();
    } else {
      const injected = connectors.find((c) => c.type === "injected");
      connect({ connector: injected || connectors[0] });
    }
  }, [connect, connectors, openConnectModal]);

  const disconnectWallet = useCallback(() => {
    disconnect();
  }, [disconnect]);

  const canAccessProtectedContent =
    status === "connected" && isConnected && !!address;

  const walletType = useMemo(() => {
    if (!connector) return null;
    const name = connector.name || connector.title || "";
    if (name.toLowerCase().includes("metamask")) return "MetaMask";
    if (name.toLowerCase().includes("walletConnect") || name.toLowerCase().includes("wallet")) return "WalletConnect";
    if (name.toLowerCase().includes("coinbase")) return "Coinbase";
    return name;
  }, [connector]);

  return {
    user: canAccessProtectedContent ? { userId: address, chainId: chain?.id } : null,
    isAuthenticated: canAccessProtectedContent,
    canAccessProtectedContent,
    walletAddress: address,
    chainId: chain?.id,
    connector,
    walletType,
    isReconnecting,
    provider: typeof window !== "undefined" && window.ethereum ? window.ethereum : null,
    connectWallet,
    disconnectWallet,
    address,
    isConnected,
    chain,
  };
};

export default function WalletProvider({ children }) {
  const auth = useWalletAuth();

  return (
    <WalletContext.Provider value={auth}>
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet() {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be inside WalletProvider");
  return ctx;
}

export function useRequireWallet() {
  const { isAuthenticated, connectWallet, canAccessProtectedContent } = useWallet();
  
  return {
    isAuthenticated,
    connectWallet,
    canAccessProtectedContent,
  };
}
