'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { supabaseConfig, requireSupabaseConfig } = require('../src/supabase');

test('supabaseConfig reads Next-style public environment names', () => {
  assert.deepEqual(supabaseConfig({
    NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example',
  }), {
    url: 'https://example.supabase.co',
    publishableKey: 'sb_publishable_example',
  });
});

test('supabaseConfig prefers server-side aliases', () => {
  assert.deepEqual(supabaseConfig({
    SUPABASE_URL: 'https://server.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'server-key',
    NEXT_PUBLIC_SUPABASE_URL: 'https://browser.supabase.co',
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'browser-key',
  }), {
    url: 'https://server.supabase.co',
    publishableKey: 'server-key',
  });
});

test('requireSupabaseConfig fails clearly when env vars are absent', () => {
  assert.throws(() => requireSupabaseConfig({}), /Supabase is not configured/);
});
