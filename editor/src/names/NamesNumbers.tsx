import { useEffect, useMemo, useRef, useState } from "react";
import { fontById, fontFamily, loadFont } from "../config/fonts";
import {
  COLORS,
  DEFAULT_LOOK,
  EXTRA_STYLES,
  NAME_SIZES_CM,
  NAME_STYLES,
  NUMBER_SIZES_CM,
  NUMBER_STYLES,
  OUTLINES,
  contrastOf,
  styleById,
  type Look,
  type Setup,
  type Style,
} from "./catalog";
import { newRow, parseRoster, readCsvFile, type Row } from "./roster";
import { TIERS, kr, nextTier, priceKey, tierFor, type PriceList } from "./pricing";
import { orderGraphics, planGraphics, totalsOf, type Graphic, type OrderProgress } from "./order";
import { SHIRT_COLORS, ShirtPreview } from "./ShirtPreview";

/**
 * "Namn och Siffror": a team's names and numbers as DTF transfers.
 *
 * Five steps on one page — what to print, style, colour, size, the list —
 * with the shirt beside them showing the first player as it will look.
 * The list can be typed, pasted from a spreadsheet or read from a CSV.
 * Each name and number is a piece priced by its size, and the volume
 * steps show what the next few pieces would save.
 */

const ACCENT = "#dc2f3c";
const INK = "#18181b";
const MUTED = "#6b6b70";
const LINE = "rgba(0,0,0,0.1)";
const SOFT = "#f5f5f4";

function useWide(ref: React.RefObject<HTMLElement | null>, min = 860) {
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWide((entry?.contentRect.width ?? 0) >= min));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, min]);
  return wide;
}

/**
 * `mode="builder"`: the same steps inside the gang sheet builder. No piece
 * prices there (the sheet is paid by length); the button puts the names
 * and numbers on the sheet instead of in the cart.
 */
export function NamesNumbers({
  prices,
  mode = "product",
  onAddToSheet,
  onDone,
}: {
  prices: PriceList;
  mode?: "product" | "builder";
  onAddToSheet?: (graphics: Graphic[], onProgress: (p: OrderProgress) => void) => Promise<void>;
  onDone?: () => void;
}) {
  const builder = mode === "builder";
  const rootRef = useRef<HTMLDivElement>(null);
  const wide = useWide(rootRef);
  const [look, setLook] = useState<Look>(DEFAULT_LOOK);
  const [rows, setRows] = useState<Row[]>([newRow(), newRow(), newRow()]);
  const [tab, setTab] = useState<"table" | "paste" | "csv">("table");
  const [paste, setPaste] = useState("");
  const [shirt, setShirt] = useState(SHIRT_COLORS[3]!.value);
  const [graphics, setGraphics] = useState<Graphic[]>([]);
  const [progress, setProgress] = useState<OrderProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState(false);
  const [showExtra, setShowExtra] = useState(false);
  const update = (patch: Partial<Look>) => setLook((l) => ({ ...l, ...patch }));

  const filled = rows.filter((r) => r.name.trim() || r.number.trim());
  const first = filled[0];

  // Price the list as it is typed (fonts load once, measuring is cheap).
  useEffect(() => {
    let alive = true;
    const t = window.setTimeout(() => {
      void planGraphics(filled, look, prices).then((g) => alive && setGraphics(g));
    }, 120);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, look, prices]);

  const totals = useMemo(() => totalsOf(graphics), [graphics]);
  const tier = tierFor(totals.pieces);
  const next = nextTier(totals.pieces);
  const discount = tier ? (totals.subtotal * tier.pct) / 100 : 0;
  const total = totals.subtotal - discount;
  const fromPrice = prices.size ? Math.min(...[...prices.values()].map((p) => p.price)) : null;
  const priceOf = (kind: "name" | "number", cm: number) => prices.get(priceKey(kind, cm))?.price ?? null;

  // A style is only the letterforms: the outline stays what the customer
  // chose under "Kontur". Picking Retro or Sport used to switch one on.
  const pickStyle = (kind: "name" | "number", style: Style) =>
    update(kind === "name" ? { nameStyle: style.id } : { numberStyle: style.id });

  const setRow = (id: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const addParsed = (parsed: Row[]) => {
    if (parsed.length === 0) {
      setError("Hittade inga namn eller nummer. En rad per spelare, t.ex. \"Andersson, 10\".");
      return;
    }
    setError(null);
    setRows((rs) => [...rs.filter((r) => r.name.trim() || r.number.trim()), ...parsed]);
    setTab("table");
  };

  // In the builder only pieces wider than the film stop the order.
  const blocked = builder ? totals.blocked.filter((g) => g.tooWide) : totals.blocked;
  const canOrder = totals.pieces > 0 && blocked.length === 0 && !progress;
  const order = async () => {
    if (!canOrder) return;
    setError(null);
    setProgress({ step: "draw", done: 0, total: graphics.length });
    try {
      if (builder) {
        await onAddToSheet?.(graphics, setProgress);
        setAdded(true);
        window.setTimeout(() => onDone?.(), 900);
        return;
      }
      await orderGraphics(graphics, look, filled, setProgress);
      setAdded(true);
      const root = (window as any).Shopify?.routes?.root || "/";
      window.setTimeout(() => (window.location.href = `${root}cart`), 1300);
    } catch (err) {
      setError((err as Error).message);
      setProgress(null);
    }
  };

  const preview = (
    <div style={{ ...S.previewCard, ...(wide ? { position: "sticky", top: 96 } : { padding: 12 }) }}>
      {/* On a phone the shirt is a reminder, not the page: it used to fill the first screen. */}
      <div style={wide ? undefined : { maxWidth: 230, margin: "0 auto" }}>
        <ShirtPreview look={look} name={first?.name ?? ""} number={first?.number ?? ""} shirt={shirt} />
      </div>
      <div style={S.previewFoot}>
        <span style={S.small}>Förhandsvisa på</span>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {SHIRT_COLORS.map((c) => (
            <button
              key={c.value}
              type="button"
              title={c.label}
              aria-label={`Tröja: ${c.label}`}
              onClick={() => setShirt(c.value)}
              style={{ ...S.swatchSmall, background: c.value, boxShadow: shirt === c.value ? `0 0 0 2px #fff, 0 0 0 4px ${ACCENT}` : "none" }}
            />
          ))}
        </div>
      </div>
      {first ? null : <div style={{ ...S.small, textAlign: "center", marginTop: 6 }}>Fyll i listan så visas första spelaren här.</div>}
    </div>
  );

  return (
    <div ref={rootRef} style={S.root}>
      <div style={{ display: "grid", gridTemplateColumns: wide ? "minmax(0, 0.9fr) minmax(0, 1.1fr)" : "minmax(0, 1fr)", gap: wide ? 40 : 20, alignItems: "start" }}>
        {/* Stretched to the row so the sticky preview has room to stay in view. */}
        <div style={{ alignSelf: "stretch" }}>{preview}</div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
          {!builder && fromPrice !== null && (
            <div style={S.priceLead}>
              Från <strong>{kr(fromPrice)}</strong> per tryck · upp till 50 % mängdrabatt · exkl. moms
            </div>
          )}

          <Step n={1} title="Vad vill du trycka?">
            <div style={S.cards3}>
              {(
                [
                  { id: "names", label: "Namn", sample: "NAMN" },
                  { id: "numbers", label: "Nummer", sample: "10" },
                  { id: "both", label: "Namn + nummer", sample: "NAMN 10" },
                ] as { id: Setup; label: string; sample: string }[]
              ).map((o) => (
                <button key={o.id} type="button" onClick={() => update({ setup: o.id })} style={{ ...S.card, ...(look.setup === o.id ? S.cardOn : null) }}>
                  <span style={S.cardSample}>{o.sample}</span>
                  <span style={S.cardLabel}>{o.label}</span>
                </button>
              ))}
            </div>
          </Step>

          <Step n={2} title="Stil">
            {look.setup !== "numbers" && (
              <StylePicker label="Namn" styles={showExtra ? [...NAME_STYLES, ...EXTRA_STYLES] : NAME_STYLES} value={look.nameStyle} sample="ABC" onPick={(s) => pickStyle("name", s)} />
            )}
            {look.setup !== "names" && (
              <StylePicker label="Nummer" styles={showExtra ? [...NUMBER_STYLES, ...EXTRA_STYLES] : NUMBER_STYLES} value={look.numberStyle} sample="23" onPick={(s) => pickStyle("number", s)} />
            )}
            <button type="button" onClick={() => setShowExtra((v) => !v)} style={S.link}>
              {showExtra ? "Färre typsnitt" : "Fler typsnitt"}
            </button>
          </Step>

          <Step n={3} title="Färg" aside={COLORS.find((c) => c.value === look.color)?.label}>
            <div style={S.swatches}>
              {COLORS.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  title={c.label}
                  aria-label={c.label}
                  aria-pressed={look.color === c.value}
                  onClick={() => update({ color: c.value, ...(look.outline === c.value ? { outline: contrastOf(c.value) } : {}) })}
                  style={{ ...S.swatch, background: c.value, boxShadow: look.color === c.value ? `0 0 0 2px #fff, 0 0 0 4px ${ACCENT}` : "none" }}
                />
              ))}
            </div>
            <div style={{ ...S.row, marginTop: 12 }}>
              <span style={S.fieldLabel}>Kontur</span>
              <Segmented
                options={OUTLINES.filter((o) => o.value !== look.color)}
                value={look.outline}
                onChange={(v) => update({ outline: v })}
              />
            </div>
          </Step>

          <Step n={4} title="Storlek" aside="Höjd på bokstäver och siffror">
            {look.setup !== "numbers" && (
              <div style={S.row}>
                <span style={S.fieldLabel}>Namn</span>
                <Chips values={NAME_SIZES_CM} value={look.nameCm} onChange={(v) => update({ nameCm: v })} price={(v) => (builder ? null : priceOf("name", v))} />
              </div>
            )}
            {look.setup !== "names" && (
              <div style={{ ...S.row, marginTop: look.setup === "both" ? 10 : 0 }}>
                <span style={S.fieldLabel}>Nummer</span>
                <Chips values={NUMBER_SIZES_CM} value={look.numberCm} onChange={(v) => update({ numberCm: v })} price={(v) => (builder ? null : priceOf("number", v))} />
              </div>
            )}
            {look.setup !== "numbers" && (
              <label style={{ ...S.row, marginTop: 12, cursor: "pointer", gap: 8 }}>
                <input type="checkbox" checked={look.uppercase} onChange={(e) => update({ uppercase: e.target.checked })} style={{ accentColor: ACCENT, width: 16, height: 16 }} />
                <span style={{ fontSize: 14 }}>Namn i versaler</span>
              </label>
            )}
          </Step>

          <Step n={5} title="Din lista" aside={`${filled.length} ${filled.length === 1 ? "spelare" : "spelare"} · ${totals.pieces} tryck`}>
            <div style={S.tabs} role="tablist">
              {(
                [
                  { id: "table", label: "Tabell" },
                  { id: "paste", label: "Klistra in" },
                  { id: "csv", label: "Ladda upp CSV" },
                ] as const
              ).map((t) => (
                <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)} style={{ ...S.tab, ...(tab === t.id ? S.tabOn : null) }}>
                  {t.label}
                </button>
              ))}
            </div>

            {tab === "table" && (
              <RosterTable
                rows={rows}
                setup={look.setup}
                onChange={setRow}
                onRemove={(id) => setRows((rs) => (rs.length > 1 ? rs.filter((r) => r.id !== id) : [newRow()]))}
                onAdd={() => setRows((rs) => [...rs, newRow()])}
              />
            )}

            {tab === "paste" && (
              <div>
                <textarea
                  value={paste}
                  onChange={(e) => setPaste(e.target.value)}
                  rows={7}
                  placeholder={"Andersson, 10\nKarlsson, 7\nNilsson, 23, 2"}
                  style={S.textarea}
                  aria-label="Klistra in listan"
                />
                <div style={S.small}>En spelare per rad: namn, nummer och antal (antal är valfritt). Funkar direkt från Excel och Google Sheets.</div>
                <button
                  type="button"
                  onClick={() => {
                    addParsed(parseRoster(paste));
                    setPaste("");
                  }}
                  style={{ ...S.secondaryBtn, marginTop: 10 }}
                >
                  Lägg till i listan
                </button>
              </div>
            )}

            {tab === "csv" && (
              <CsvDrop
                onFile={async (file) => {
                  try {
                    addParsed(parseRoster(await readCsvFile(file)));
                  } catch {
                    setError("Kunde inte läsa filen. Spara den som CSV och försök igen.");
                  }
                }}
              />
            )}
          </Step>

          {builder ? (
            <div style={S.summary}>
              <div style={{ ...S.sumRow, fontSize: 14, color: MUTED, marginBottom: 12 }}>
                <span>{totals.pieces} tryck läggs på arket</span>
                <span>Arket växer om det behövs</span>
              </div>
              {blocked.length > 0 && (
                <div style={{ ...S.error, marginTop: 0, marginBottom: 12 }}>
                  {blocked.slice(0, 3).map((g) => `"${g.text}" blir bredare än filmen i ${g.heightCm} cm`).join(". ")}. Välj en mindre storlek.
                </div>
              )}
              <button type="button" onClick={() => void order()} disabled={!canOrder} style={{ ...S.primary, ...(canOrder ? null : S.primaryOff) }}>
                {progress ? "Lägger på arket…" : totals.pieces ? `Lägg ${totals.pieces} tryck på arket` : "Fyll i listan för att fortsätta"}
              </button>
            </div>
          ) : (
          <Summary
            pieces={totals.pieces}
            subtotal={totals.subtotal}
            discount={discount}
            total={total}
            tierPct={tier?.pct ?? 0}
            next={next}
            blocked={totals.blocked.map((g) => (g.tooWide ? `"${g.text}" blir bredare än filmen i ${g.heightCm} cm` : `${g.kind === "name" ? "Namn" : "Nummer"} ${g.heightCm} cm saknar pris`))}
            canOrder={canOrder}
            busy={Boolean(progress)}
            onOrder={() => void order()}
            sticky={false}
          />
          )}
          {error && <div style={S.error}>{error}</div>}
        </div>
      </div>

      {/* Phones: the total and the button stay in reach while the list grows. */}
      {!wide && !builder && (
        <div style={S.mobileBar}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 16 }}>{totals.pieces ? kr(Math.round(total * 100) / 100) : "—"}</div>
            <div style={S.small}>
              {totals.pieces} tryck{tier ? ` · −${tier.pct} %` : ""}
            </div>
          </div>
          <button type="button" onClick={() => void order()} disabled={!canOrder} style={{ ...S.primary, width: "auto", padding: "12px 18px", ...(canOrder ? null : S.primaryOff) }}>
            Lägg i varukorg
          </button>
        </div>
      )}

      {progress && <ProgressModal progress={progress} added={added} builder={builder} />}
    </div>
  );
}

function Step({ n, title, aside, children }: { n: number; title: string; aside?: string; children: React.ReactNode }) {
  return (
    <section style={S.step}>
      <header style={S.stepHead}>
        <span style={S.stepNo}>{n}</span>
        <h3 style={S.stepTitle}>{title}</h3>
        {aside && <span style={{ ...S.small, marginLeft: "auto" }}>{aside}</span>}
      </header>
      {children}
    </section>
  );
}

function StylePicker({
  label,
  styles,
  value,
  sample,
  onPick,
}: {
  label: string;
  styles: Style[];
  value: string;
  sample: string;
  onPick: (s: Style) => void;
}) {
  const [, setLoaded] = useState(0);
  useEffect(() => {
    for (const s of styles) void loadFont(fontById(s.fontId)).then(() => setLoaded((n) => n + 1));
  }, [styles]);
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ ...S.fieldLabel, marginBottom: 8 }}>{label}</div>
      <div style={S.styleGrid}>
        {styles.map((s) => {
          const on = s.id === value;
          return (
            <button key={s.id} type="button" onClick={() => onPick(s)} aria-pressed={on} style={{ ...S.styleCard, ...(on ? S.cardOn : null) }}>
              <span
                style={{
                  fontFamily: `"${fontFamily(fontById(s.fontId))}", sans-serif`,
                  fontSize: 26,
                  lineHeight: 1.1,
                  color: INK,
                }}
              >
                {sample}
              </span>
              <span style={S.cardLabel}>{s.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Segmented({ options, value, onChange }: { options: { value: string; label: string }[]; value: string; onChange: (v: string) => void }) {
  return (
    <div style={S.segmented}>
      {options.map((o) => (
        <button key={o.value} type="button" onClick={() => onChange(o.value)} aria-pressed={o.value === value} style={{ ...S.segment, ...(o.value === value ? S.segmentOn : null) }}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Chips({
  values,
  value,
  onChange,
  price,
}: {
  values: number[];
  value: number;
  onChange: (v: number) => void;
  price: (v: number) => number | null;
}) {
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {values.map((v) => {
        const p = price(v);
        return (
          <button key={v} type="button" onClick={() => onChange(v)} aria-pressed={v === value} style={{ ...S.chip, ...(v === value ? S.chipOn : null) }}>
            <span style={{ fontWeight: 600 }}>{v} cm</span>
            {p !== null && <span style={{ fontSize: 11.5, opacity: 0.75 }}>{kr(p)}/st</span>}
          </button>
        );
      })}
    </div>
  );
}

function RosterTable({
  rows,
  setup,
  onChange,
  onRemove,
  onAdd,
}: {
  rows: Row[];
  setup: Setup;
  onChange: (id: string, patch: Partial<Row>) => void;
  onRemove: (id: string) => void;
  onAdd: () => void;
}) {
  const showName = setup !== "numbers";
  const showNumber = setup !== "names";
  // Narrow number and count columns: three digits and a stepper need no
  // more, and on a phone the name field got 70 px ("Anderss").
  const cols = [showName ? "minmax(0, 1fr)" : "", showNumber ? "56px" : "", "92px", "24px"].filter(Boolean).join(" ");
  return (
    <div>
      <div style={{ ...S.tableHead, gridTemplateColumns: cols }}>
        {showName && <span>Namn</span>}
        {showNumber && <span>Nummer</span>}
        <span>Antal</span>
        <span />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {rows.map((r, i) => (
          <div key={r.id} style={{ display: "grid", gridTemplateColumns: cols, gap: 6, alignItems: "center" }}>
            {showName && (
              <input
                value={r.name}
                onChange={(e) => onChange(r.id, { name: e.target.value.slice(0, 30) })}
                placeholder={i === 0 ? "Andersson" : "Namn"}
                aria-label={`Namn rad ${i + 1}`}
                style={S.input}
              />
            )}
            {showNumber && (
              <input
                value={r.number}
                onChange={(e) => onChange(r.id, { number: e.target.value.replace(/[^\d]/g, "").slice(0, 3) })}
                placeholder={i === 0 ? "10" : "#"}
                inputMode="numeric"
                aria-label={`Nummer rad ${i + 1}`}
                style={{ ...S.input, textAlign: "center" }}
              />
            )}
            <div style={S.stepper}>
              <button type="button" onClick={() => onChange(r.id, { qty: Math.max(1, r.qty - 1) })} style={S.stepBtn} aria-label="Färre">
                −
              </button>
              <span style={{ minWidth: 24, textAlign: "center", fontVariantNumeric: "tabular-nums" }}>{r.qty}</span>
              <button type="button" onClick={() => onChange(r.id, { qty: Math.min(999, r.qty + 1) })} style={S.stepBtn} aria-label="Fler">
                +
              </button>
            </div>
            <button type="button" onClick={() => onRemove(r.id)} style={S.remove} aria-label={`Ta bort rad ${i + 1}`}>
              ×
            </button>
          </div>
        ))}
      </div>
      <button type="button" onClick={onAdd} style={{ ...S.secondaryBtn, marginTop: 10 }}>
        + Lägg till rad
      </button>
    </div>
  );
}

function CsvDrop({ onFile }: { onFile: (f: File) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files[0];
        if (f) onFile(f);
      }}
      onClick={() => input.current?.click()}
      style={{ ...S.drop, ...(over ? { borderColor: ACCENT, background: "rgba(220,47,60,0.05)" } : null) }}
    >
      <input
        ref={input}
        type="file"
        accept=".csv,text/csv,.txt"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
      <div style={{ fontWeight: 600, color: INK }}>Dra hit en CSV-fil eller klicka</div>
      <div style={{ ...S.small, marginTop: 4 }}>Kolumner: namn, nummer, antal. Rubrikrad är okej. Spara från Excel som CSV.</div>
    </div>
  );
}

function Summary({
  pieces,
  subtotal,
  discount,
  total,
  tierPct,
  next,
  blocked,
  canOrder,
  busy,
  onOrder,
  sticky,
}: {
  pieces: number;
  subtotal: number;
  discount: number;
  total: number;
  tierPct: number;
  next: { min: number; pct: number } | null;
  blocked: string[];
  canOrder: boolean;
  busy: boolean;
  onOrder: () => void;
  sticky: boolean;
}) {
  return (
    <div style={{ ...S.summary, ...(sticky ? { position: "sticky", bottom: 8, zIndex: 5 } : null) }}>
      <div style={S.tiers}>
        {TIERS.map((t) => (
          <div key={t.min} style={{ ...S.tier, ...(tierPct >= t.pct ? S.tierOn : null) }}>
            <span style={{ fontWeight: 700 }}>−{t.pct} %</span>
            <span style={{ fontSize: 11 }}>{t.min}+ st</span>
          </div>
        ))}
      </div>
      {next && pieces > 0 && (
        <div style={{ ...S.small, marginTop: 8 }}>
          Lägg till {next.min - pieces} tryck till för {next.pct} % rabatt.
        </div>
      )}
      <div style={S.sumRows}>
        <div style={S.sumRow}>
          <span>{pieces} tryck</span>
          <span>{pieces ? kr(subtotal) : "—"}</span>
        </div>
        {discount > 0 && (
          <div style={{ ...S.sumRow, color: "#2e7d32" }}>
            <span>Mängdrabatt {tierPct} %</span>
            <span>−{kr(Math.round(discount * 100) / 100)}</span>
          </div>
        )}
        <div style={{ ...S.sumRow, fontWeight: 700, fontSize: 17, color: INK }}>
          <span>Totalt</span>
          <span>{pieces ? kr(Math.round(total * 100) / 100) : "—"}</span>
        </div>
        <div style={{ ...S.small, textAlign: "right" }}>Exkl. moms. Rabatten dras i kassan.</div>
      </div>
      {blocked.length > 0 && (
        <div style={S.error}>
          {blocked.slice(0, 3).join(". ")}. Välj en mindre storlek eller korta namnet.
        </div>
      )}
      <button type="button" onClick={onOrder} disabled={!canOrder} style={{ ...S.primary, ...(canOrder ? null : S.primaryOff) }}>
        {busy ? "Lägger i varukorgen…" : pieces ? `Lägg i varukorg · ${kr(Math.round(total * 100) / 100)}` : "Fyll i listan för att fortsätta"}
      </button>
    </div>
  );
}

function ProgressModal({ progress, added, builder }: { progress: OrderProgress; added: boolean; builder: boolean }) {
  const steps: { id: OrderProgress["step"]; label: string }[] = [
    { id: "draw", label: "Ritar namn och nummer" },
    { id: "upload", label: `Sparar trycken${progress.total ? ` (${Math.min(progress.done, progress.total)} av ${progress.total})` : ""}` },
    { id: "sheet", label: builder ? "Lägger dem på arket" : "Bygger tryckarket" },
    ...(builder ? [] : [{ id: "cart" as const, label: "Lägger i varukorgen" }]),
  ];
  const at = added ? steps.length : steps.findIndex((s) => s.id === progress.step);
  const pct = added ? 100 : Math.round(((at + (progress.step === "upload" && progress.total ? progress.done / progress.total : 0)) / steps.length) * 100);
  return (
    <div style={S.backdrop}>
      <div role="dialog" aria-modal="true" aria-label="Lägger i varukorgen" style={S.modal}>
        <h3 style={{ margin: "0 0 4px", fontSize: 17, color: added ? "#2e7d32" : INK }}>
          {builder ? (added ? "Klart" : "Lägger på arket") : added ? "Tillagt i varukorgen" : "Lägger i varukorgen"}
        </h3>
        <p style={{ ...S.small, margin: "0 0 14px" }}>
          {builder ? (added ? "Namnen och numren ligger på arket." : "Vi ritar varje namn och nummer i 300 DPI.") : added ? "Går till varukorgen…" : "Vi gör ett färdigt tryckark av din lista."}
        </p>
        <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 10 }}>
          {steps.map((s, i) => (
            <li key={s.id} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 14, color: i < at ? "#2e7d32" : i === at ? INK : "#a1a1a6" }}>
              <span style={{ width: 18, display: "flex", justifyContent: "center" }}>
                {i < at ? "✓" : i === at ? <span style={S.spinner} /> : "•"}
              </span>
              {s.label}
            </li>
          ))}
        </ol>
        <div style={{ height: 6, borderRadius: 3, background: "#eceef1", overflow: "hidden", marginTop: 16 }}>
          <div style={{ height: "100%", width: `${Math.max(6, pct)}%`, background: added ? "#2e7d32" : ACCENT, transition: "width 0.3s ease" }} />
        </div>
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  root: { fontFamily: "inherit", color: INK, width: "100%" },
  previewCard: { background: SOFT, borderRadius: 18, padding: 18 },
  previewFoot: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginTop: 10 },
  priceLead: { fontSize: 14, color: MUTED },
  small: { fontSize: 12.5, color: MUTED, lineHeight: 1.45 },
  step: { border: `1px solid ${LINE}`, borderRadius: 16, padding: "16px 16px 18px", background: "#fff" },
  stepHead: { display: "flex", alignItems: "center", gap: 10, marginBottom: 12 },
  stepNo: {
    width: 24,
    height: 24,
    borderRadius: "50%",
    background: INK,
    color: "#fff",
    fontSize: 12,
    fontWeight: 700,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  stepTitle: { margin: 0, fontSize: 15, fontWeight: 700, letterSpacing: "0.01em" },
  cards3: { display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 },
  card: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 6,
    padding: "14px 8px 12px",
    border: `1px solid ${LINE}`,
    borderRadius: 12,
    background: "#fff",
    cursor: "pointer",
    font: "inherit",
    color: INK,
  },
  cardOn: { border: `1.5px solid ${ACCENT}`, background: "rgba(220,47,60,0.05)", boxShadow: `0 0 0 1px ${ACCENT}` },
  cardSample: { fontSize: 18, fontWeight: 800, letterSpacing: "0.04em", whiteSpace: "nowrap" },
  cardLabel: { fontSize: 12.5, color: MUTED, fontWeight: 500 },
  styleGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(84px, 1fr))", gap: 8 },
  styleCard: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 4,
    padding: "10px 6px 8px",
    border: `1px solid ${LINE}`,
    borderRadius: 12,
    background: "#fff",
    cursor: "pointer",
    font: "inherit",
  },
  link: { border: "none", background: "none", padding: 0, color: ACCENT, fontWeight: 600, fontSize: 13, cursor: "pointer", font: "inherit" },
  swatches: { display: "flex", gap: 8, flexWrap: "wrap" },
  swatch: { width: 30, height: 30, borderRadius: "50%", border: "1px solid rgba(0,0,0,0.18)", padding: 0, cursor: "pointer" },
  swatchSmall: { width: 20, height: 20, borderRadius: "50%", border: "1px solid rgba(0,0,0,0.18)", padding: 0, cursor: "pointer" },
  row: { display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" },
  fieldLabel: { fontSize: 13, fontWeight: 600, minWidth: 60 },
  segmented: { display: "inline-flex", padding: 3, gap: 3, borderRadius: 10, background: SOFT },
  segment: { border: "none", background: "transparent", padding: "7px 14px", borderRadius: 8, cursor: "pointer", fontFamily: "inherit", fontSize: 13, color: MUTED },
  segmentOn: { background: "#fff", color: INK, fontWeight: 600, boxShadow: "0 1px 3px rgba(0,0,0,0.1)" },
  chip: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    lineHeight: 1.25,
    // Longhands only: chipOn changes the colour and the weight, and with the
    // shorthands React left the last pick's black border on when it moved.
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: LINE,
    background: "#fff",
    borderRadius: 12,
    padding: "7px 14px",
    cursor: "pointer",
    fontFamily: "inherit",
    fontSize: 13,
    color: INK,
    minWidth: 64,
  },
  chipOn: { background: INK, borderColor: INK, color: "#fff", fontWeight: 600 },
  tabs: { display: "flex", gap: 4, padding: 3, borderRadius: 10, background: SOFT, marginBottom: 12 },
  tab: { flex: 1, border: "none", background: "transparent", padding: "8px 6px", borderRadius: 8, cursor: "pointer", fontFamily: "inherit", fontSize: 13, color: MUTED },
  tabOn: { background: "#fff", color: INK, fontWeight: 600, boxShadow: "0 1px 3px rgba(0,0,0,0.1)" },
  tableHead: { display: "grid", gap: 6, fontSize: 11.5, fontWeight: 600, color: MUTED, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6, padding: "0 2px" },
  input: {
    width: "100%",
    boxSizing: "border-box",
    padding: "10px 11px",
    border: `1px solid rgba(0,0,0,0.16)`,
    borderRadius: 10,
    font: "inherit",
    fontSize: 16,
    color: INK,
    background: "#fff",
    minWidth: 0,
  },
  stepper: { display: "flex", alignItems: "center", justifyContent: "space-between", border: "1px solid rgba(0,0,0,0.16)", borderRadius: 10, padding: 2, height: 42, boxSizing: "border-box" },
  stepBtn: { width: 28, height: 34, border: "none", background: "transparent", fontSize: 18, cursor: "pointer", color: INK, fontFamily: "inherit", padding: 0 },
  remove: { width: 24, height: 28, border: "none", background: "transparent", color: "#a1a1a6", fontSize: 20, cursor: "pointer", padding: 0 },
  secondaryBtn: {
    border: `1px solid rgba(0,0,0,0.16)`,
    background: "#fff",
    borderRadius: 10,
    padding: "9px 14px",
    cursor: "pointer",
    font: "inherit",
    fontSize: 13.5,
    fontWeight: 600,
    color: INK,
  },
  textarea: {
    width: "100%",
    boxSizing: "border-box",
    padding: 12,
    border: "1px solid rgba(0,0,0,0.16)",
    borderRadius: 10,
    font: "inherit",
    fontSize: 16,
    lineHeight: 1.5,
    resize: "vertical",
    marginBottom: 6,
  },
  drop: { border: "2px dashed rgba(0,0,0,0.18)", borderRadius: 12, padding: "22px 14px", textAlign: "center", cursor: "pointer", background: "#fff" },
  summary: { border: `1px solid ${LINE}`, borderRadius: 16, padding: 16, background: "#fff", boxShadow: "0 8px 30px rgba(0,0,0,0.06)" },
  tiers: { display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 6 },
  tier: { display: "flex", flexDirection: "column", alignItems: "center", padding: "7px 4px", borderRadius: 10, background: SOFT, color: MUTED, fontSize: 13 },
  tierOn: { background: "rgba(46,125,50,0.1)", color: "#2e7d32" },
  sumRows: { display: "flex", flexDirection: "column", gap: 6, margin: "14px 0 12px", fontSize: 14, color: MUTED },
  sumRow: { display: "flex", justifyContent: "space-between" },
  primary: {
    width: "100%",
    border: "none",
    borderRadius: 12,
    background: ACCENT,
    color: "#fff",
    padding: "15px 16px",
    fontWeight: 700,
    fontSize: 15,
    cursor: "pointer",
    font: "inherit",
  },
  primaryOff: { background: "#e8e8ea", color: "#8e8e93", cursor: "not-allowed" },
  mobileBar: {
    position: "sticky",
    bottom: 0,
    zIndex: 5,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    marginTop: 14,
    padding: "10px 14px",
    background: "rgba(255,255,255,0.96)",
    backdropFilter: "blur(8px)",
    borderTop: `1px solid ${LINE}`,
    boxShadow: "0 -6px 20px rgba(0,0,0,0.06)",
  },
  error: { marginTop: 10, padding: "10px 12px", borderRadius: 10, background: "#fff4ed", border: "1px solid #fed7aa", color: "#9a3412", fontSize: 13.5 },
  backdrop: { position: "fixed", inset: 0, background: "rgba(17,17,20,0.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 2147483000 },
  modal: { width: "100%", maxWidth: 400, background: "#fff", borderRadius: 18, padding: 22, boxShadow: "0 24px 80px rgba(0,0,0,0.25)", fontFamily: "inherit" },
  spinner: {
    display: "inline-block",
    width: 14,
    height: 14,
    borderRadius: "50%",
    border: `2px solid ${ACCENT}`,
    borderTopColor: "transparent",
    animation: "gs-nn-spin 0.8s linear infinite",
  },
};
