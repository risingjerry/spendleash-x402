/**
 * Hero visual: the agent in the center, merchants inside the leash, an attacker outside it.
 * Paid requests fly to merchants and land; the injected one hits the leash and sparks.
 * Pure SVG + SMIL, no JS. Freezes under prefers-reduced-motion via CSS.
 */
const C = 300;
const LEASH_R = 200;
const CYCLE = 7.2;

function polar(r: number, deg: number) {
  const a = (deg * Math.PI) / 180;
  return { x: +(C + r * Math.cos(a)).toFixed(1), y: +(C + r * Math.sin(a)).toFixed(1) };
}

const merchants = [
  { label: "api.quotes", deg: 200, r: 132, at: 0 },
  { label: "inference", deg: 115, r: 140, at: 1.5 },
  { label: "data.feed", deg: 300, r: 128, at: 3 },
];
const evil = { label: "0xEVIL…", deg: 30, r: 262 };
const hit = polar(LEASH_R, evil.deg);
const evilPos = polar(evil.r, evil.deg);
const BAD_AT = 4.6;

export function Orbit() {
  return (
    <div className="orbit-wrap" aria-hidden="true">
      <svg className="orbit" viewBox="0 0 600 600" role="img">
        <defs>
          <linearGradient id="leashStroke" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#f0abfc" />
            <stop offset="0.5" stopColor="#a78bfa" />
            <stop offset="1" stopColor="#5b47ff" />
          </linearGradient>
          <radialGradient id="core" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0" stopColor="rgba(240,171,252,.35)" />
            <stop offset="1" stopColor="rgba(240,171,252,0)" />
          </radialGradient>
        </defs>

        <circle className="ring" cx={C} cy={C} r={285} strokeDasharray="1 7" />
        <circle className="ring" cx={C} cy={C} r={240} />
        <circle cx={C} cy={C} r={150} fill="url(#core)" />
        <circle className="ring-leash" cx={C} cy={C} r={LEASH_R} />
        <circle className="ring-pulse" cx={C} cy={C} r={LEASH_R} />

        {/* cap ticks on the leash */}
        {Array.from({ length: 48 }, (_, i) => {
          const a = polar(LEASH_R - 6, i * 7.5);
          const b = polar(LEASH_R + (i % 4 === 0 ? 10 : 4), i * 7.5);
          return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="rgba(255,255,255,.18)" strokeWidth="1" />;
        })}
        <text x={C} y={C - LEASH_R - 18} textAnchor="middle">
          leash · 0.05/call · 0.10/day
        </text>

        {merchants.map((m) => {
          const p = polar(m.r, m.deg);
          return (
            <g key={m.label}>
              <line x1={C} y1={C} x2={p.x} y2={p.y} stroke="rgba(255,255,255,.07)" strokeDasharray="2 4" />
              <rect className="node" x={p.x - 9} y={p.y - 9} width="18" height="18" rx="3" />
              <circle className="paid-flash" cx={p.x} cy={p.y} r="16">
                <animate attributeName="opacity" values="0;0;.55;0;0" keyTimes={`0;${(m.at + 0.9) / CYCLE};${(m.at + 1) / CYCLE};${(m.at + 1.6) / CYCLE};1`} dur={`${CYCLE}s`} repeatCount="indefinite" />
              </circle>
              <text x={p.x} y={p.y + 30} textAnchor="middle">
                {m.label}
              </text>
              <circle className="packet" r="4" opacity="0">
                <animateMotion path={`M${C} ${C} L${p.x} ${p.y}`} keyPoints="0;0;1;1" keyTimes={`0;${m.at / CYCLE};${(m.at + 1) / CYCLE};1`} calcMode="linear" dur={`${CYCLE}s`} repeatCount="indefinite" />
                <animate attributeName="opacity" values="0;0;1;1;0;0" keyTimes={`0;${m.at / CYCLE};${(m.at + 0.05) / CYCLE};${(m.at + 0.95) / CYCLE};${(m.at + 1) / CYCLE};1`} dur={`${CYCLE}s`} repeatCount="indefinite" />
              </circle>
            </g>
          );
        })}

        {/* attacker outside the leash */}
        <line x1={C} y1={C} x2={evilPos.x} y2={evilPos.y} stroke="rgba(255,125,140,.18)" strokeDasharray="2 4" />
        <rect className="node node-evil" x={evilPos.x - 10} y={evilPos.y - 10} width="20" height="20" rx="3" />
        <text className="label-evil" x={evilPos.x} y={evilPos.y + 32} textAnchor="middle">
          {evil.label}
        </text>
        <circle className="packet-bad" r="4" opacity="0">
          <animateMotion path={`M${C} ${C} L${hit.x} ${hit.y}`} keyPoints="0;0;1;1" keyTimes={`0;${BAD_AT / CYCLE};${(BAD_AT + 0.8) / CYCLE};1`} calcMode="linear" dur={`${CYCLE}s`} repeatCount="indefinite" />
          <animate attributeName="opacity" values="0;0;1;1;0;0" keyTimes={`0;${BAD_AT / CYCLE};${(BAD_AT + 0.05) / CYCLE};${(BAD_AT + 0.78) / CYCLE};${(BAD_AT + 0.82) / CYCLE};1`} dur={`${CYCLE}s`} repeatCount="indefinite" />
        </circle>
        <circle className="spark" cx={hit.x} cy={hit.y} r="4">
          <animate attributeName="r" values="4;4;30;30" keyTimes={`0;${(BAD_AT + 0.8) / CYCLE};${(BAD_AT + 1.5) / CYCLE};1`} dur={`${CYCLE}s`} repeatCount="indefinite" />
          <animate attributeName="opacity" values="0;0;1;0;0" keyTimes={`0;${(BAD_AT + 0.79) / CYCLE};${(BAD_AT + 0.82) / CYCLE};${(BAD_AT + 1.5) / CYCLE};1`} dur={`${CYCLE}s`} repeatCount="indefinite" />
        </circle>
        <text className="label-evil" x={hit.x - 8} y={hit.y - 18} textAnchor="end" opacity="0">
          MerchantNotAllowed
          <animate attributeName="opacity" values="0;0;1;1;0;0" keyTimes={`0;${(BAD_AT + 0.8) / CYCLE};${(BAD_AT + 0.9) / CYCLE};${(BAD_AT + 2.2) / CYCLE};${(BAD_AT + 2.4) / CYCLE};1`} dur={`${CYCLE}s`} repeatCount="indefinite" />
        </text>

        {/* the agent */}
        <circle cx={C} cy={C} r="22" fill="none" stroke="rgba(255,255,255,.25)" />
        <circle className="node-agent" cx={C} cy={C} r="9" />
        <text className="label-agent" x={C} y={C + 46} textAnchor="middle">
          agent · 0 gas · 0 funds
        </text>
      </svg>
    </div>
  );
}
