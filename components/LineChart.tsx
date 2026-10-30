"use client";

import { useMemo, useRef, useState } from "react";

export interface Series {
  name: string;
  slot: number; // categorical colour slot 1..8 (fixed per entity, never by rank)
  dashed?: boolean;
  points: { t: number; v: number }[];
}

const W = 900;
const PAD = { top: 12, right: 92, bottom: 26, left: 64 };

function nearest(points: { t: number }[], t: number): number {
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(points[lo - 1].t - t) < Math.abs(points[lo].t - t)) return lo - 1;
  return lo;
}

const fmtDate = (t: number, withTime: boolean) =>
  new Date(t).toISOString().slice(withTime ? 5 : 0, withTime ? 16 : 10).replace("T", " ");

export function LineChart({
  series,
  height = 280,
  baseline,
  unit = "usd",
  label,
}: {
  series: Series[];
  height?: number;
  baseline?: number;
  unit?: "usd" | "pips";
  label: string;
}) {
  let digits = 0; // set from the axis span below, so tiny ranges don't round to repeated labels
  const format = (v: number) =>
    unit === "usd"
      ? `${v < 0 ? "-" : ""}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
      : v.toFixed(1);
  const ref = useRef<SVGSVGElement>(null);
  const [hoverT, setHoverT] = useState<number | null>(null);
  const live = series.filter((s) => s.points.length > 0);

  const geo = useMemo(() => {
    const all = live.flatMap((s) => s.points);
    if (!all.length) return null;
    let t0 = Math.min(...all.map((p) => p.t));
    let t1 = Math.max(...all.map((p) => p.t));
    if (t1 === t0) t1 = t0 + 1;
    const vals = all.map((p) => p.v).concat(baseline !== undefined ? [baseline] : []);
    let v0 = Math.min(...vals);
    let v1 = Math.max(...vals);
    if (v1 === v0) {
      v0 -= 1;
      v1 += 1;
    }
    const padV = (v1 - v0) * 0.06;
    v0 -= padV;
    v1 += padV;
    const x = (t: number) => PAD.left + ((t - t0) / (t1 - t0)) * (W - PAD.left - PAD.right);
    const y = (v: number) => PAD.top + (1 - (v - v0) / (v1 - v0)) * (height - PAD.top - PAD.bottom);
    const ticks = Array.from({ length: 5 }, (_, i) => v0 + ((v1 - v0) * i) / 4);
    return { t0, t1, x, y, ticks, withTime: t1 - t0 < 3 * 864e5 };
  }, [live, baseline, height]);

  if (!geo) {
    return <div className="empty">No data yet: {label}</div>;
  }
  const { x, y, ticks, t0, t1, withTime } = geo;
  digits = ticks[ticks.length - 1] - ticks[0] < 20 ? 2 : 0;

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = ref.current!.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const t = t0 + ((px - PAD.left) / (W - PAD.left - PAD.right)) * (t1 - t0);
    setHoverT(Math.max(t0, Math.min(t1, t)));
  };

  const hover =
    hoverT === null
      ? null
      : live.map((s) => {
          const p = s.points[nearest(s.points, hoverT)];
          return { s, p };
        });

  // End-of-line direct labels, nudged apart so they don't overlap.
  const ends = live
    .map((s) => ({ s, y: y(s.points[s.points.length - 1].v) }))
    .sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) ends[i].y = Math.max(ends[i].y, ends[i - 1].y + 13);

  return (
    <figure className="chart" aria-label={label}>
      {live.length > 1 && (
        <figcaption className="legend">
          {live.map((s) => (
            <span key={s.name}>
              <i className={`swatch s${s.slot}${s.dashed ? " dashed" : ""}`} />
              {s.name}
            </span>
          ))}
        </figcaption>
      )}
      <div className="chart-wrap">
        <svg
          ref={ref}
          viewBox={`0 0 ${W} ${height}`}
          role="img"
          onPointerMove={onMove}
          onPointerLeave={() => setHoverT(null)}
        >
          {ticks.map((v) => (
            <g key={v}>
              <line className="grid" x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} />
              <text className="axis" x={PAD.left - 8} y={y(v) + 4} textAnchor="end">
                {format(v)}
              </text>
            </g>
          ))}
          {baseline !== undefined && (
            <line className="baseline" x1={PAD.left} x2={W - PAD.right} y1={y(baseline)} y2={y(baseline)} />
          )}
          <text className="axis" x={PAD.left} y={height - 6}>
            {fmtDate(t0, withTime)}
          </text>
          <text className="axis" x={W - PAD.right} y={height - 6} textAnchor="end">
            {fmtDate(t1, withTime)}
          </text>
          {live.map((s) => (
            <polyline
              key={s.name}
              className={`line s${s.slot}${s.dashed ? " dashed" : ""}`}
              points={s.points.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ")}
            />
          ))}
          {live.length <= 6 &&
            ends.map(({ s, y: ly }) => (
              <text key={s.name} className="end-label" x={W - PAD.right + 6} y={ly + 4}>
                {s.name}
              </text>
            ))}
          {hover && hoverT !== null && (
            <g>
              <line className="crosshair" x1={x(hoverT)} x2={x(hoverT)} y1={PAD.top} y2={height - PAD.bottom} />
              {hover.map(({ s, p }) => (
                <circle key={s.name} className={`dot s${s.slot}`} cx={x(p.t)} cy={y(p.v)} r={4} />
              ))}
            </g>
          )}
        </svg>
        {hover && hoverT !== null && (
          <div
            className="tooltip"
            style={{ left: `${(x(hoverT) / W) * 100}%`, transform: x(hoverT) > W / 2 ? "translateX(calc(-100% - 12px))" : "translateX(12px)" }}
          >
            <div className="tt-time">{fmtDate(hover[0].p.t, true)} UTC</div>
            {hover.map(({ s, p }) => (
              <div key={s.name} className="tt-row">
                <i className={`swatch s${s.slot}${s.dashed ? " dashed" : ""}`} />
                <span>{s.name}</span>
                <b>{format(p.v)}</b>
              </div>
            ))}
          </div>
        )}
      </div>
    </figure>
  );
}
