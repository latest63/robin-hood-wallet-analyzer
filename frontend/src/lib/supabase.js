import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://zfsraiallzuettkvfdzs.supabase.co'
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'eyJhbG...PIYU'

export const supabase = createClient(supabaseUrl, supabaseAnonKey)

// Helper functions for wallet-based auth
export const getOrCreateUser = async (address) => {
  const { data: existing } = await supabase
    .from('users')
    .select('*')
    .eq('wallet_address', address.toLowerCase())
    .single()

  if (existing) {
    // Update last login
    await supabase
      .from('users')
      .update({ last_login_at: new Date().toISOString() })
      .eq('wallet_address', address.toLowerCase())
    return existing
  }

  const { data: newUser, error } = await supabase
    .from('users')
    .insert([{ wallet_address: address.toLowerCase() }])
    .select()
    .single()

  if (error) throw error
  return newUser
}

// Cluster operations
export const getUserClusters = async (address) => {
  const { data, error } = await supabase
    .from('clusters')
    .select(`
      *,
      cluster_wallets (*)
    `)
    .eq('user_wallet', address.toLowerCase())
    .order('created_at', { ascending: false })

  if (error) throw error
  return data || []
}

export const createCluster = async (address, cluster) => {
  const { data, error } = await supabase
    .from('clusters')
    .insert([{
      user_wallet: address.toLowerCase(),
      name: cluster.name,
      token_address: cluster.token_address,
      token_symbol: cluster.token_symbol
    }])
    .select()
    .single()

  if (error) throw error
  return data
}

export const addWalletsToCluster = async (clusterId, wallets) => {
  const { data, error } = await supabase
    .from('cluster_wallets')
    .insert(wallets.map(w => ({
      cluster_id: clusterId,
      wallet_address: w.wallet.toLowerCase(),
      profit: w.profit || 0,
      pnl_pct: w.pnl_pct || 0
    })))
    .select()

  if (error) throw error
  return data
}

export const deleteCluster = async (clusterId) => {
  const { error } = await supabase
    .from('clusters')
    .delete()
    .eq('id', clusterId)

  if (error) throw error
}

// Monitor operations
export const startMonitor = async (clusterId, address, webhookUrl) => {
  const { data, error } = await supabase
    .from('monitors')
    .insert([{
      cluster_id: clusterId,
      user_wallet: address.toLowerCase(),
      webhook_url: webhookUrl
    }])
    .select()
    .single()

  if (error) throw error
  return data
}

export const stopMonitor = async (monitorId) => {
  const { error } = await supabase
    .from('monitors')
    .update({ active: false })
    .eq('id', monitorId)

  if (error) throw error
}

export const getUserMonitors = async (address) => {
  const { data, error } = await supabase
    .from('monitors')
    .select(`
      *,
      clusters (name, token_symbol)
    `)
    .eq('user_wallet', address.toLowerCase())
    .order('created_at', { ascending: false })

  if (error) throw error
  return data || []
}
