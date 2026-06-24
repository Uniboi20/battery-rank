// ============================================================
// Netlify Scheduled Function: Daily Amazon Price Scraper
// File: netlify/functions/scrape-prices.js
//
// Setup:
//   1. npm install node-fetch @supabase/supabase-js
//   2. Add to netlify.toml:
//      [functions."scrape-prices"]
//        schedule = "0 8 * * *"   # runs at 8am UTC daily
//   3. Set environment variables in Netlify dashboard:
//      SUPABASE_URL, SUPABASE_SERVICE_KEY
// ============================================================

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY; // service role key (bypasses RLS)

// Realistic browser headers to reduce Amazon blocking
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
};

// Sleep utility to avoid rate limiting
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Fetch the current price for an Amazon product by ASIN.
 * Returns price as a number, or null if not found.
 *
 * NOTE: Amazon actively blocks scrapers. This works for now but may
 * need to be replaced with the Amazon Product Advertising API once
 * you have an Associates account. The ASIN is already stored in the DB.
 */
async function fetchAmazonPrice(asin) {
  const url = `https://www.amazon.com/dp/${asin}?th=1`;
  
  try {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) {
      console.warn(`HTTP ${res.status} for ASIN ${asin}`);
      return null;
    }
    
    const html = await res.text();
    
    // Try multiple price selectors (Amazon changes these periodically)
    const patterns = [
      // Primary: span.a-price > span.a-offscreen (most reliable)
      /<span class="a-offscreen">\$([0-9,]+\.[0-9]{2})<\/span>/,
      // Fallback 1: priceblock_ourprice
      /id="priceblock_ourprice"[^>]*>\$([0-9,]+\.[0-9]{2})/,
      // Fallback 2: corePrice_feature_div
      /corePrice_feature_div[^$]*\$([0-9,]+\.[0-9]{2})/,
      // Fallback 3: data-a-color="price"
      /data-a-color="price"[^>]*>.*?\$([0-9,]+\.[0-9]{2})/s,
    ];
    
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match) {
        const price = parseFloat(match[1].replace(',', ''));
        if (price > 0 && price < 10000) { // sanity check
          return price;
        }
      }
    }
    
    console.warn(`Could not extract price for ASIN ${asin}`);
    return null;
  } catch (err) {
    console.error(`Error fetching ASIN ${asin}:`, err.message);
    return null;
  }
}

exports.handler = async function() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return { statusCode: 500, body: 'Missing Supabase env vars' };
  }
  
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  
  // Fetch all batteries that have an ASIN
  const { data: batteries, error } = await supabase
    .from('batteries')
    .select('id, brand, model, asin, price')
    .not('asin', 'is', null);
  
  if (error) {
    console.error('Supabase fetch error:', error);
    return { statusCode: 500, body: error.message };
  }
  
  console.log(`Scraping prices for ${batteries.length} batteries...`);
  
  const results = { updated: 0, unchanged: 0, failed: 0 };
  const now = new Date().toISOString();
  
  for (const battery of batteries) {
    // Polite delay between requests (2-4 seconds random)
    await sleep(2000 + Math.random() * 2000);
    
    const newPrice = await fetchAmazonPrice(battery.asin);
    
    if (newPrice === null) {
      results.failed++;
      console.warn(`  FAILED: ${battery.brand} ${battery.model} (${battery.asin})`);
      continue;
    }
    
    if (newPrice === battery.price) {
      results.unchanged++;
      console.log(`  SAME: ${battery.brand} ${battery.model} = $${newPrice}`);
    } else {
      // Price changed — update battery and log history
      await supabase
        .from('batteries')
        .update({ price: newPrice, price_updated_at: now, updated_at: now })
        .eq('id', battery.id);
      
      await supabase
        .from('price_history')
        .insert({ battery_id: battery.id, price: newPrice, recorded_at: now });
      
      results.updated++;
      console.log(`  UPDATED: ${battery.brand} ${battery.model} $${battery.price} → $${newPrice}`);
    }
  }
  
  console.log(`Done. Updated: ${results.updated}, Unchanged: ${results.unchanged}, Failed: ${results.failed}`);
  
  return {
    statusCode: 200,
    body: JSON.stringify(results),
  };
};
