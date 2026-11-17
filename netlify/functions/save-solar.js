// ============================================================
// Netlify Function: create, edit, re-price or delete a solar panel, for admin.html
// File: netlify/functions/save-solar.js
//
// POST { secret, fields }              -> creates a panel, returns it
// POST { secret, id, fields }          -> updates only the fields sent, returns the row
// POST { secret, id, delete: true }    -> deletes the panel
//
// Saving a price always refreshes price_updated_at, even when it didn't change, so the
// "checked" badge on the admin page stays honest. The database logs a price-history row
// on its own whenever the price actually changes.
// Same env vars as the battery functions:
//   SUPABASE_URL, SUPABASE_ADMIN_KEY (service_role), ADMIN_TOOL_SECRET
// ============================================================

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ADMIN_KEY;
const ADMIN_TOOL_SECRET = process.env.ADMIN_TOOL_SECRET;

const TYPES = ['portable', 'rigid'];

const COLUMNS = {
  brand: 'text', model: 'text', asin: 'asin', price: 'num',
  panel_type: 'type', rated_w: 'int',
  voc_v: 'dec', isc_a: 'dec', weight_lb: 'dec', efficiency_pct: 'dec',
  ip_rating: 'short', connector: 'short', bifacial: 'bool', notes: 'longtext',
};
const REQUIRED = ['brand', 'model', 'asin', 'price', 'panel_type', 'rated_w'];

function clean(key, type, val) {
  if (val === null || val === '' || val === undefined) {
    return { value: type === 'bool' ? false : null };
  }
  switch (type) {
    case 'type':
      return TYPES.includes(val) ? { value: val } : { error: 'Invalid panel type' };
    case 'text':
      if (typeof val !== 'string' || val.trim().length > 100) return { error: `Invalid ${key}` };
      return { value: val.trim() || null };
    case 'short':
      if (typeof val !== 'string' || val.trim().length > 40) return { error: `Invalid ${key} (max 40 characters)` };
      return { value: val.trim() || null };
    case 'longtext':
      if (typeof val !== 'string' || val.length > 500) return { error: `Invalid ${key} (max 500 characters)` };
      return { value: val.trim() || null };
    case 'asin': {
      const a = typeof val === 'string' ? val.trim().toUpperCase() : '';
      return /^[A-Z0-9]{10}$/.test(a) ? { value: a } : { error: 'Invalid ASIN — must be 10 letters/digits' };
    }
    case 'num': {
      const n = Number(val);
      return n > 0 && n < 10000 ? { value: Math.round(n * 100) / 100 } : { error: `${key} out of range` };
    }
    case 'dec': {
      const n = Number(val);
      return n > 0 && n < 1000 ? { value: Math.round(n * 100) / 100 } : { error: `${key} out of range` };
    }
    case 'int': {
      const n = Number(val);
      return Number.isInteger(n) && n > 0 && n < 100000 ? { value: n } : { error: `${key} must be a whole number above 0` };
    }
    case 'bool':
      return typeof val === 'boolean' ? { value: val } : { error: `${key} must be true/false` };
  }
  return { error: `Unknown field ${key}` };
}

const isMissing = v => v === null || v === undefined || v === '';
const reply = (statusCode, body) => ({ statusCode, body: typeof body === 'string' ? body : JSON.stringify(body) });

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return reply(405, 'Method not allowed');
  if (!SUPABASE_URL || !SUPABASE_KEY || !ADMIN_TOOL_SECRET) {
    return reply(500, 'Server not configured — missing env vars');
  }

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
    const { data, error } = await supabase.from('solar_panels').delete().eq('id', numericId).select('id');
    if (error) return reply(500, { error: error.message });
    if (!data || !data.length) return reply(404, 'No panel with that id');
    return reply(200, { ok: true, id: numericId });
  }

  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return reply(400, 'Missing fields');
  const row = {};
  for (const [key, val] of Object.entries(fields)) {
    const type = COLUMNS[key];
    if (!type) return reply(400, `Field not editable: ${key}`);
    const { value, error } = clean(key, type, val);
    if (error) return reply(400, error);
    row[key] = value;
  }

  const now = new Date().toISOString();

  if (isCreate) {
    const missing = REQUIRED.filter(k => isMissing(row[k]));
    if (missing.length) return reply(400, `Missing required: ${missing.join(', ')}`);
    const { data, error } = await supabase.from('solar_panels')
      .insert({ ...row, price_updated_at: now, updated_at: now }).select().single();
    if (error) return reply(500, { error: error.message });
    return reply(200, { ok: true, row: data });
  }

  if (!Object.keys(row).length) return reply(400, 'Nothing to update');
  const blanked = Object.keys(row).filter(k => REQUIRED.includes(k) && isMissing(row[k]));
  if (blanked.length) return reply(400, `Can't clear required: ${blanked.join(', ')}`);

  const update = { ...row, updated_at: now };
  if ('price' in row) update.price_updated_at = now;
  const { data, error } = await supabase.from('solar_panels').update(update).eq('id', numericId).select();
  if (error) return reply(500, { error: error.message });
  if (!data || !data.length) return reply(404, 'No panel with that id');
  return reply(200, { ok: true, row: data[0] });
};
