// ============================================================
// Shared solar logic for solar.html and the power stations page (index.html).
//
// Panel value: lowest price per rated watt wins, ranked separately for portable (folding) and
// rigid panels, since rigid panels are far cheaper per watt but need mounting and aren't
// something you carry to a campsite. Weight is deliberately left out.
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
// Parallel strings add current, so they're only used when both the panel's short-circuit
// current and the port's current limit are known and the total stays under it.
function portLayout(s, p, count) {
  for (let series = count; series >= 1; series--) {
    if (count % series) continue;
    const parallel = count / series;
    if (!stringFits(s, p, series)) continue;
    if (parallel > 1 && !(p.isc_a && s.solar_max_a && p.isc_a * parallel <= s.solar_max_a)) continue;
    return { series, parallel };
  }
  return null;
}

// The best way to wire `p` to station `s`: fewest panels that reach the target, otherwise the
// most solar the station will accept from this panel. Returns null if it can't be wired safely.
function solarConfig(s, p) {
  const target = solarTarget(s);
  if (!target || !p.rated_w) return null;
  const ports = Math.max(1, s.solar_ports || 1);
  const perPortW = s.solar_input_w / ports;
  let best = null;
  for (let n = 1; n <= SOLAR.maxPanels; n++) {
    const strings = splitStrings(n, ports);
    const layouts = strings.map(c => portLayout(s, p, c));
    if (layouts.some(l => !l)) continue;
    const usable = Math.min(s.solar_input_w,
      strings.reduce((t, c) => t + Math.min(c * p.rated_w, perPortW), 0));
    const cfg = { panel: p, count: n, strings, layouts, usable, target, cost: n * p.price,
                  reaches: usable >= target * 0.95 };
    if (cfg.reaches) return cfg;
    if (!best || usable > best.usable) best = cfg;
  }
  // Too little to be worth suggesting (under half the target).
  return best && best.usable >= target * 0.5 ? best : null;
}

// Cheapest panel setup for a station from a list of panels (portable by default).
function bestSolarFor(s, panels, type = 'portable') {
  let pick = null;
  for (const p of panels) {
    if (type && p.panel_type !== type) continue;
    if (!p.asin) continue;
    const cfg = solarConfig(s, p);
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
  const v = panels.filter(p => p.panel_type === type).map(dollarsPerWatt).sort((a, b) => a - b);
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
