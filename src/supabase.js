'use strict';

let clientPromise = null;

function supabaseConfig(env = process.env) {
  const url = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = env.SUPABASE_PUBLISHABLE_KEY || env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  return { url, publishableKey };
}

function requireSupabaseConfig(env = process.env) {
  const cfg = supabaseConfig(env);
  if (!cfg.url || !cfg.publishableKey) {
    throw new Error('Supabase is not configured. Set SUPABASE_URL/SUPABASE_PUBLISHABLE_KEY or NEXT_PUBLIC_SUPABASE_URL/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.');
  }
  return cfg;
}

async function createSupabaseClient(options = {}) {
  const { createClient } = await import('@supabase/supabase-js');
  const cfg = requireSupabaseConfig();
  return createClient(cfg.url, cfg.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    ...options,
  });
}

function getSupabaseClient(options) {
  if (!clientPromise) clientPromise = createSupabaseClient(options);
  return clientPromise;
}

module.exports = {
  supabaseConfig,
  requireSupabaseConfig,
  createSupabaseClient,
  getSupabaseClient,
};
