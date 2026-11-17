// ============================================================
// Shared solar logic for solar.html and the power stations page (index.html).
//
// Panel value: lowest price per rated watt wins. Folding (portable) panels only; weight is
// deliberately left out.
//
// Pairing: aim for rated solar of about a third of the battery's Wh (roughly a full refill in
// one good sunny day), capped by the station's own solar input limit. Panels are wired in
// series on each solar port, and each string has to stay inside that port's voltage range.
// ============================================================

const SOLAR = {
  targetRatio: 1 / 3,   // rated panel watts per Wh of battery
  derate: 0.75,         // real output vs rated in good sun (heat, angle, wiring)
  vmpRatio: 0.82,       // operating voltage is about 82% of open-circuit voltage
  maxPanels: 8,
};

function dollarsPerWatt(p) { return p.price / p.rated_w; }
// A panel with no price of its own is sold only in bundles.
const soldAlone = p => Number(p.price) > 0 && !!p.asin;

// Target rated solar watts for a station.
function solarTarget(s) {
  if (!s.solar_input_w || !s.capacity_wh) return 0;
  return Math.min(s.capacity_wh * SOLAR.targetRatio, s.solar_input_w);
}

// Split n panels across the station's solar ports as evenly as possible (series strings).
function splitStrings(n, ports) {
  const used = Math.min(n, ports);
  const base = Math.floor(n / used), extra = n % used;
  return Array.from({ length: used }, (_, i) => base + (i < extra ? 1 : 0));
}

// Is a series string of `count` panels inside the port's voltage range? Unknown station limits
// pass; a missing panel Voc only passes for a single panel on a station with no voltage limit.
function stringFits(s, p, count) {
  if (!p.voc_v) return !s.solar_v_max && count === 1;
  const voc = p.voc_v * count;
  if (s.solar_v_max && voc > s.solar_v_max) return false;
  if (s.solar_v_min && voc * SOLAR.vmpRatio < s.solar_v_min) return false;
  return true;
}

// How to wire `count` panels on one port: `series` panels per string, `parallel` strings.
// Voltage is a hard limit. Current isn't: a station only draws up to its own current limit, so
// extra parallel strings just get clipped (see portWatts). Longest strings first, for less current.
function portLayout(s, p, count) {
  for (let series = count; series >= 1; series--) {
    if (count % series) continue;
    if (!stringFits(s, p, series)) continue;
    return { series, parallel: count / series };
  }
  return null;
}

// Watts one port actually takes: the panels' rating, capped by the port's share of the station's
// solar limit and by its current limit at the string's operating voltage.
function portWatts(s, p, count, layout, perPortW) {
  const ampCap = s.solar_max_a && p.voc_v
    ? s.solar_max_a * SOLAR.vmpRatio * p.voc_v * layout.series : Infinity;
  return Math.min(count * p.rated_w, perPortW, ampCap);
}

// The best way to wire `p` to station `s`: fewest panels that reach the target, otherwise the
// most solar the station will accept from this panel. Returns null if it can't be wired safely.
// One setup: n of panel p on station s, or null if the panels can't be wired to fit.
function configFor(s, p, n) {
  const target = solarTarget(s);
  if (!target || !p.rated_w) return null;
  const ports = Math.max(1, s.solar_ports || 1);
  const perPortW = s.solar_input_w / ports;
  const strings = splitStrings(n, ports);
  const layouts = strings.map(c => portLayout(s, p, c));
  if (layouts.some(l => !l)) return null;
  const usable = Math.min(s.solar_input_w,
    strings.reduce((t, c, i) => t + portWatts(s, p, c, layouts[i], perPortW), 0));
  // Some stations (DJI) need a separate solar adapter; its price counts toward the setup.
  const cost = n * (Number(p.price) || 0) + (s.solar_adapter ? Number(s.solar_adapter_price) || 0 : 0);
  return { panel: p, station: s, count: n, strings, layouts, usable, target, cost,
           reaches: usable >= target * 0.95 };
}

function solarConfig(s, p) {
  let best = null;
  for (let n = 1; n <= SOLAR.maxPanels; n++) {
    const cfg = configFor(s, p, n);
    if (!cfg) continue;
    if (cfg.reaches) return cfg;
    if (!best || cfg.usable > best.usable) best = cfg;
  }
  // Too little to be worth suggesting (under half the target).
  return best && best.usable >= best.target * 0.5 ? best : null;
}

// A bundle (one listing with the station and its panels) is just another way to buy a setup.
// Its solar cost is the bundle price minus the station's own price, so if the bundle is
// cheaper than buying the parts separately, it wins the cheapest-setup comparison below.
function bundleConfig(s, bundle, panels) {
  const p = panels.find(x => x.id === bundle.panel_id);
  if (!p || bundle.battery_id !== s.id) return null;
  const cfg = configFor(s, p, bundle.panel_count);
  if (!cfg || cfg.usable < cfg.target * 0.5) return null;
  const adapter = cfg.cost - bundle.panel_count * (Number(p.price) || 0);
  const separate = soldAlone(p) ? cfg.cost : Infinity; // bundle-only panels can't be bought separately
  cfg.cost = Number(bundle.price) - Number(s.price) + adapter;
  if (cfg.cost >= separate) return null; // buying separately is as cheap or cheaper
  cfg.bundle = bundle;
  return cfg;
}

// Cheapest panel setup for a station from a list of panels (portable by default), counting
// any bundles for that station as candidates too.
function bestSolarFor(s, panels, type = 'portable', bundles = []) {
  const cands = [];
  for (const p of panels) {
    if (type && p.panel_type !== type) continue;
    if (!soldAlone(p)) continue;
    cands.push(solarConfig(s, p));
  }
  for (const b of bundles) cands.push(bundleConfig(s, b, panels));
  let pick = null;
  for (const cfg of cands) {
    if (!cfg) continue;
    if (!pick ||
        (cfg.reaches && !pick.reaches) ||
        (cfg.reaches === pick.reaches && (cfg.reaches
          ? cfg.cost < pick.cost
          : cfg.usable / cfg.cost > pick.usable / pick.cost))) pick = cfg;
  }
  return pick;
}

// Hours of good sun to go from empty to full with this setup.
function refillHours(s, cfg) {
  return s.capacity_wh / (cfg.usable * SOLAR.derate);
}

// The going rate for portable solar ($/W), used to judge whether a pairing is a bargain.
function medianDollarsPerWatt(panels, type = 'portable') {
  const v = panels.filter(p => p.panel_type === type && soldAlone(p)).map(dollarsPerWatt).sort((a, b) => a - b);
  if (!v.length) return 0;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// Extra value a solar setup adds to a station's score: the solar it actually delivers (up to
// the target) at the going rate, minus what the panels cost. A typical panel nets about zero;
// a cheaper-than-usual setup nets a bonus, and a station that can't take much solar gains little.
function solarCredit(cfg, rate) {
  return Math.round(Math.min(cfg.usable, cfg.target) * rate - cfg.cost);
}

function fmtSunHours(h) {
  if (h < 1) return 'under an hour';
  const r = h < 10 ? Math.round(h * 2) / 2 : Math.round(h);
  return `about ${r} hour${r === 1 ? '' : 's'}`;
}

// Plain-language wiring, e.g. "2 panels in series" or "4 panels, 2 on each of 2 solar ports".
function wiringText(cfg) {
  const n = cfg.count;
  if (n === 1) return '1 panel';
  const ports = cfg.strings.length;
  const anyParallel = cfg.layouts.some(l => l.parallel > 1);
  const anySeries = cfg.layouts.some(l => l.series > 1);
  const how = anyParallel && anySeries ? 'in series and parallel'
    : anyParallel ? 'in parallel' : anySeries ? 'in series' : '';
  if (ports > 1) {
    const each = cfg.strings.every(c => c === cfg.strings[0]) ? `${cfg.strings[0]} on each of ${ports} solar ports`
      : `split across ${ports} solar ports`;
    return `${n} panels, ${each}${how ? `, ${how}` : ''}`;
  }
  return `${n} panels ${how}`.trim();
}
