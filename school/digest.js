// Turns a flight trace into a compact flight report an LLM can read in one glance.
const f1 = (v) => (typeof v === 'number' ? (Math.round(v * 10) / 10).toString() : String(v));

export function digest(trace, { every = 0.5, maxRows = 48 } = {}) {
  const out = [];
  out.push(`duration ${trace.duration}s · crashed: ${trace.crashed ? trace.crashReason : 'no'} · maxY ${trace.maxY} m · maxAlt ${trace.maxAlt} m · maxSpeed ${trace.maxSpeed} m/s`);
  if (trace.controllerError) out.push(`CONTROLLER ERROR at t=${trace.controllerError.t}s: ${trace.controllerError.message} (the car got no input after this)`);
  const fin = trace.final;
  out.push(`final: pos (${f1(fin.x)}, ${f1(fin.y)}, ${f1(fin.z)}) speed ${f1(fin.speed)} heading ${f1(fin.heading)} upY ${f1(fin.upY)} wheels ${fin.wheels} airborne ${fin.airborne} armed ${fin.armed} gas ${f1(fin.gas)} surface ${fin.surface}`);
  if (trace.rings.length) out.push(`rings passed: ${trace.rings.map((r) => `ring ${r.ring} at t=${r.t}`).join(', ')}`);
  if (trace.flights.length) {
    out.push('air time segments:');
    for (const f of trace.flights.slice(0, 6)) {
      out.push(`  t ${f.t0}-${f.t1}s from ${f.from}: start (${f1(f.start.x)}, ${f1(f.start.y)}, ${f1(f.start.z)}) -> end (${f1(f.end.x)}, ${f1(f.end.y)}, ${f1(f.end.z)}), maxY ${f.maxY}, rotation pitch ${f.pitchDeg}° roll ${f.rollDeg}° yaw ${f.yawDeg}°, tricks [${f.tricks.join(', ')}]${f.overTruck ? `, over truck (clearance ${f.minTruckClearance} m)` : ''}, landed upY ${f.landUpright}${f.landVy != null ? ` vy ${f.landVy}` : ''}${f.crashedOnLanding ? ' -> CRASH' : ''}`);
    }
  }
  const evs = trace.events.filter((e) => e.type !== 'ring').slice(0, 14);
  if (evs.length) {
    out.push('events:');
    for (const e of evs) {
      const { t, type, ...rest } = e;
      out.push(`  t=${t} ${type} ${Object.entries(rest).map(([k, v]) => `${k}=${f1(v)}`).join(' ')}`);
    }
  }
  out.push('timeline (t | x y z | alt | speed | heading | upY | surface | air/armed | gas | cmd th/br/st/li/pi/ro):');
  const step = Math.max(every, trace.duration / maxRows);
  let next = 0;
  for (const s of trace.samples) {
    if (s.t + 1e-6 < next) continue;
    next = s.t + step;
    const c = s.cmd;
    out.push(`  ${f1(s.t)} | ${f1(s.x)} ${f1(s.y)} ${f1(s.z)} | ${f1(s.alt)} | ${f1(s.speed)} | ${f1(s.heading)} | ${f1(s.upY)} | ${s.surface} | ${s.airborne ? 'AIR' : 'gnd'}${s.armed ? '+JETS' : ''} | ${f1(s.gas)} | ${c.th}/${c.br}/${c.st}/${c.li}/${c.pi}/${c.ro}`);
  }
  return out.join('\n');
}

// tiny signature used by the watchdog to spot an agent repeating the same failure
export function signature(trace, specResult) {
  const fails = (specResult?.results || []).filter((r) => !r.pass).map((r) => r.name).sort().join('|');
  const fin = trace.final;
  return {
    crash: trace.crashReason || null,
    fails,
    end: [Math.round(fin.x / 4), Math.round(fin.z / 4)].join(','),
    maxY: Math.round(trace.maxY / 2),
  };
}
