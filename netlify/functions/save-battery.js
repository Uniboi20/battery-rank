// ============================================================
// Netlify Function: create a battery, or edit any of its fields, for admin.html
// File: netlify/functions/save-battery.js
//
// POST { secret, fields }       -> creates a new row, returns it
// POST { secret, id, fields }   -> updates only the fields sent, returns the row
//
// Only columns in COLUMNS below can be written; anything else is rejected.
// Uses the same env vars as update-price.js:
//   SUPABASE_URL, SUPABASE_ADMIN_KEY (service_role), ADMIN_TOOL_SECRET
// ============================================================

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ADMIN_KEY;
const ADMIN_TOOL_SECRET = process.env.ADMIN_TOOL_SECRET;

const CATEGORIES = ['power_station', 'power_bank'];

// column -> type. 'int' and 'num' accept null (cleared field) unless required.
const COLUMNS = {
  category: 'category',
  brand: 'text', model: 'text', asin: 'asin', url: 'url', notes: 'longtext',
  price: 'num',
  capacity_wh: 'int', capacity_mah: 'int', peak_power_w: 'int',
  outlets_120v: 'int', l2_outlets: 'int', usb_outlets: 'int', builtin_cables: 'int',
  expandable: 'bool', app_support: 'bool', jump_starter: 'bool',
  has_magsafe: 'bool', has_builtin_cable: 'bool', has_display: 'bool', has_wall_plug: 'bool',
};

// Fields the public site needs to render a row without breaking.
const REQUIRED = {
  common: ['category', 'brand', 'model', 'price', 'peak_power_w', 'usb_outlets'],
  power_station: ['capacity_wh'],
  power_bank: ['capacity_mah'],
};

function clean(key, type, val) {
  if (val === null || val === '' || val === undefined) {
    if (type === 'bool') return { value: false };
    return { value: null };
  }
  switch (type) {
    case 'category':
      return CATEGORIES.includes(val) ? { value: val } : { error: 'Invalid category' };
    case 'text':
      if (typeof val !== 'string' || val.trim().length > 100) return { error: `Invalid ${key}` };
      return { value: val.trim() || null };
    case 'longtext':
      if (typeof val !== 'string' || val.length > 500) return { error: `Invalid ${key} (max 500 characters)` };
      return { value: val.trim() || null };
    case 'asin': {
      const a = typeof val === 'string' ? val.trim().toUpperCase() : '';
      return /^[A-Z0-9]{10}$/.test(a) ? { value: a } : { error: 'Invalid ASIN — must be 10 letters/digits' };
    }
    case 'url':
      if (typeof val !== 'string' || !/^https:\/\/(www\.)?amazon\.com\//i.test(val.trim())) {
        return { error: 'URL must be an https://www.amazon.com/ link' };
      }
      return { value: val.trim() };
    case 'num': {
      const n = Number(val);
      return n > 0 && n < 10000 ? { value: Math.round(n * 100) / 100 } : { error: `${key} out of range` };
    }
    case 'int': {
      const n = Number(val);
      return Number.isInteger(n) && n >= 0 && n < 1000000 ? { value: n } : { error: `${key} must be a whole number ≥ 0` };
    }
    case 'bool':
      return typeof val === 'boolean' ? { value: val } : { error: `${key} must be true/false` };
  }
  return { error: `Unknown field ${key}` };
}

const isMissing = v => v === null || v === undefined || v === '';

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

  const { secret, id, fields } = payload;
  if (typeof secret !== 'string' || secret !== ADMIN_TOOL_SECRET) {
    return { statusCode: 401, body: 'Unauthorized' };
  }
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    return { statusCode: 400, body: 'Missing fields' };
  }

  const row = {};
  for (const [key, val] of Object.entries(fields)) {
    const type = COLUMNS[key];
    if (!type) return { statusCode: 400, body: `Field not editable: ${key}` };
    const { value, error } = clean(key, type, val);
    if (error) return { statusCode: 400, body: error };
    row[key] = value;
  }

  const isCreate = id === undefined || id === null;
  const now = new Date().toISOString();
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  if (isCreate) {
    const required = [...REQUIRED.common, ...(REQUIRED[row.category] || [])];
    const missing = required.filter(k => isMissing(row[k]));
    if (missing.length) return { statusCode: 400, body: `Missing required: ${missing.join(', ')}` };
    if (isMissing(row.asin) && isMissing(row.url)) {
      return { statusCode: 400, body: 'Add an ASIN (or an Amazon URL) so the product can be linked' };
    }

    const { data, error } = await supabase
      .from('batteries')
      .insert({ ...row, price_updated_at: now, updated_at: now })
      .select()
      .single();
    if (error) return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    return { statusCode: 200, body: JSON.stringify({ ok: true, row: data }) };
  }

  const numericId = parseInt(id, 10);
  if (!Number.isInteger(numericId) || numericId <= 0) {
    return { statusCode: 400, body: 'Invalid id' };
  }
  if (!Object.keys(row).length) return { statusCode: 400, body: 'Nothing to update' };

  // On edits, a required field that's sent can't be blanked out.
  const allRequired = [...REQUIRED.common, ...REQUIRED.power_station, ...REQUIRED.power_bank];
  const blanked = Object.keys(row).filter(k => allRequired.includes(k) && isMissing(row[k]));
  // capacity_wh / capacity_mah are only required for their own category, so allow clearing the other one.
  const blockers = blanked.filter(k =>
    REQUIRED.common.includes(k) ||
    (row.category && (REQUIRED[row.category] || []).includes(k)));
  if (blockers.length) return { statusCode: 400, body: `Can't clear required: ${blockers.join(', ')}` };

  const update = { ...row, updated_at: now };
  if ('price' in row) update.price_updated_at = now;

  const { data, error } = await supabase
    .from('batteries')
    .update(update)
    .eq('id', numericId)
    .select();
  if (error) return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  if (!data || !data.length) return { statusCode: 404, body: 'No battery with that id' };
  return { statusCode: 200, body: JSON.stringify({ ok: true, row: data[0] }) };
};
