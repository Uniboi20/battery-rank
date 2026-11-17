// ============================================================
// Netlify Function: create, edit, re-price or delete a battery + solar bundle, for admin.html
// File: netlify/functions/save-bundle.js
//
// POST { secret, fields }              -> creates a bundle, returns it
// POST { secret, id, fields }          -> updates only the fields sent, returns the row
// POST { secret, id, delete: true }    -> deletes the bundle
//
// A bundle is one Amazon listing that sells a power station with N solar panels. The site
// compares its price with buying the same parts separately and uses whichever is cheaper.
// Saving a price always refreshes price_updated_at; the database logs price history itself.
// Same env vars as the other admin functions:
//   SUPABASE_URL, SUPABASE_ADMIN_KEY (service_role), ADMIN_TOOL_SECRET
// ============================================================

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ADMIN_KEY;
const ADMIN_TOOL_SECRET = process.env.ADMIN_TOOL_SECRET;

const COLUMNS = { battery_id: 'id', panel_id: 'id', panel_count: 'count', price: 'num', asin: 'asin' };
const REQUIRED = Object.keys(COLUMNS);

function clean(key, type, val) {
  if (val === null || val === '' || val === undefined) return { value: null };
  switch (type) {
    case 'id': {
      const n = Number(val);
      return Number.isInteger(n) && n > 0 ? { value: n } : { error: `Invalid ${key}` };
    }
    case 'count': {
      const n = Number(val);
      return Number.isInteger(n) && n >= 1 && n <= 8 ? { value: n } : { error: 'Panel count must be 1 to 8' };
    }
    case 'num': {
      const n = Number(val);
      return n > 0 && n < 20000 ? { value: Math.round(n * 100) / 100 } : { error: `${key} out of range` };
    }
    case 'asin': {
      const a = typeof val === 'string' ? val.trim().toUpperCase() : '';
      return /^[A-Z0-9]{10}$/.test(a) ? { value: a } : { error: 'Invalid ASIN — must be 10 letters/digits' };
    }
  }
  return { error: `Unknown field ${key}` };
}

const reply = (statusCode, body) => ({ statusCode, body: typeof body === 'string' ? body : JSON.stringify(body) });

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return reply(405, 'Method not allowed');
  if (!SUPABASE_URL || !SUPABASE_KEY || !ADMIN_TOOL_SECRET) return reply(500, 'Server not configured — missing env vars');

  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch { return reply(400, 'Invalid JSON'); }
  const { secret, id, fields } = payload;
  if (typeof secret !== 'string' || secret !== ADMIN_TOOL_SECRET) return reply(401, 'Unauthorized');

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  const isCreate = id === undefined || id === null;
  const numericId = parseInt(id, 10);
  if (!isCreate && !(Number.isInteger(numericId) && numericId > 0)) return reply(400, 'Invalid id');

  if (payload.delete === true) {
    if (isCreate) return reply(400, 'Missing id');
    const { data, error } = await supabase.from('solar_bundles').delete().eq('id', numericId).select('id');
    if (error) return reply(500, { error: error.message });
    if (!data || !data.length) return reply(404, 'No bundle with that id');
    return reply(200, { ok: true, id: numericId });
  }

  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return reply(400, 'Missing fields');
  const row = {};
  for (const [key, val] of Object.entries(fields)) {
    const type = COLUMNS[key];
    if (!type) return reply(400, `Field not editable: ${key}`);
    const { value, error } = clean(key, type, val);
    if (error) return reply(400, error);
    if (value === null) return reply(400, `Missing ${key}`);
    row[key] = value;
  }
  const now = new Date().toISOString();

  if (isCreate) {
    const missing = REQUIRED.filter(k => row[k] === undefined);
    if (missing.length) return reply(400, `Missing required: ${missing.join(', ')}`);
    const { data, error } = await supabase.from('solar_bundles')
      .insert({ ...row, price_updated_at: now, updated_at: now }).select().single();
    if (error) return reply(500, { error: error.message });
    return reply(200, { ok: true, row: data });
  }

  if (!Object.keys(row).length) return reply(400, 'Nothing to update');
  const update = { ...row, updated_at: now };
  if ('price' in row) update.price_updated_at = now;
  const { data, error } = await supabase.from('solar_bundles').update(update).eq('id', numericId).select();
  if (error) return reply(500, { error: error.message });
  if (!data || !data.length) return reply(404, 'No bundle with that id');
  return reply(200, { ok: true, row: data[0] });
};
