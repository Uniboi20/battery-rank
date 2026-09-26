// ============================================================
// Netlify Function: delete a battery row, for admin.html
// File: netlify/functions/delete-battery.js
//
// On-demand only. Lets the admin tool remove products that are no longer
// available without giving the public page direct write access to Supabase.
// Uses the same env vars as update-price.js:
//   SUPABASE_URL, SUPABASE_ADMIN_KEY (service_role), ADMIN_TOOL_SECRET
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

  const { secret, id } = payload;

  if (typeof secret !== 'string' || secret !== ADMIN_TOOL_SECRET) {
    return { statusCode: 401, body: 'Unauthorized' };
  }

  const numericId = parseInt(id, 10);
  if (!Number.isInteger(numericId) || numericId <= 0) {
    return { statusCode: 400, body: 'Invalid id' };
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  // .select() returns the deleted rows, so a missing id reports 404 instead of a silent success.
  const { data, error } = await supabase
    .from('batteries')
    .delete()
    .eq('id', numericId)
    .select('id');

  if (error) {
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
  if (!data || !data.length) {
    return { statusCode: 404, body: 'No battery with that id' };
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true, id: numericId }) };
};
