// ============================================================
// Netlify Function: manual price update endpoint for admin.html
// File: netlify/functions/update-price.js
//
// On-demand only (no schedule, no automated calls) — this exists so a human
// can save a price they looked up themselves in a browser, without giving the
// public admin.html page direct write access to Supabase.
//
// Required Netlify env vars (set these in the Netlify dashboard, Site
// configuration -> Environment variables — never paste real secret values
// into chat with an AI assistant, including this one):
//   SUPABASE_URL         — already set from the old scraper function
//   SUPABASE_ADMIN_KEY   — the Supabase "service_role" key
//                          (Supabase dashboard -> Project Settings -> API)
//   ADMIN_TOOL_SECRET     — a password of your own choosing, just for
//                          gating this one endpoint. Enter the same value
//                          into admin.html when you use it.
// ============================================================

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ADMIN_KEY;
const ADMIN_TOOL_SECRET = process.env.ADMIN_TOOL_SECRET;

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }
  if (!SUPABASE_URL || !SUPABASE_KEY || !ADMIN_TOOL_SECRET) {
    return { statusCode: 500, body: 'Server not configured — missing env vars' };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const { secret, id, price } = payload;

  // Constant-time-ish comparison isn't critical here (low-value single-user
  // gate, not a real auth system), but do keep it a straight equality check.
  if (typeof secret !== 'string' || secret !== ADMIN_TOOL_SECRET) {
    return { statusCode: 401, body: 'Unauthorized' };
  }

  const numericId = parseInt(id, 10);
  const numericPrice = parseFloat(price);

  if (!Number.isInteger(numericId) || numericId <= 0) {
    return { statusCode: 400, body: 'Invalid id' };
  }
  if (!(numericPrice > 0 && numericPrice < 10000)) {
    return { statusCode: 400, body: 'Price out of range' };
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  const now = new Date().toISOString();

  // price_updated_at/updated_at are set explicitly here (not left to the
  // database trigger) so re-saving the *same* price still refreshes the
  // "checked Xd ago" freshness badge — the trigger's job is to catch price
  // changes made some other way (e.g. editing directly in Supabase Studio),
  // this path handles both cases itself.
  const { error } = await supabase
    .from('batteries')
    .update({ price: numericPrice, price_updated_at: now, updated_at: now })
    .eq('id', numericId);

  if (error) {
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true, id: numericId, price: numericPrice }) };
};
