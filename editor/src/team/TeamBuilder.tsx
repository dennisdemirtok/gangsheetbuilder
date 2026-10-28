import { useEffect, useMemo, useRef, useState } from "react";
import { fontById, fontFamily, loadFont } from "../config/fonts";
import { COLORS, contrastOf } from "../names/catalog";
import {
  DIGIT_HEIGHTS_CM,
  LOGO_WIDTHS_CM,
  SIZE_CHART,
  countDigits,
  digitKey,
  kr,
  logoKey,
  parseNumbers,
  type Club,
  type TeamData,
} from "./data";
import { fileFromUrl, orderTeam, type OrderProgress, type Piece } from "./order";

/**
 * The team page: shirts, a club, digits and sponsors in one order.
 *
 * 1. The shirt: one colour, a quantity per size.
 * 2. The club, if any: partner clubs have their logo saved; any other club
 *    uploads its own.
 * 3. The digits 0-9: filled in from the number of players (1-15 needs
 *    eight ones) or the team's own numbers, then adjustable one by one.
 * 4. Sponsor logos, as many as the team has.
 *
 * The shirt beside it shows the back and front to scale, for the smallest
 * size ordered unless another is picked under it, so a 25 cm number on a
 * 110/120 shirt looks as big as it is.
 */

const ACCENT = "#dc2f3c";
const INK = "#18181b";
const MUTED = "#6b6b70";
const LINE = "rgba(0,0,0,0.1)";
const SOFT = "#f5f5f4";
const VAT = 0.25;

const STYLES = [
  { id: "arena", label: "Arena", fontId: "tc-egen-kantig" },
  { id: "skugglinje", label: "Skugglinje", fontId: "tc-egen-skugglinje" },
];

/**
 * Figure widths as shares of the figure height, measured on the 300 dpi
 * sheets the fonts were traced from, and the gap between two figures.
 */
const WIDTHS: Record<string, { d: number; 1: number; 4?: number }> = {
  "tc-egen-kantig": { d: 0.5004, 1: 0.3172 },
  "tc-egen-skugglinje": { d: 0.54, 1: 0.3568, 4: 0.5024 },
};
const FIGURE_GAP = 0.0686;

function numberWidthCm(fontId: string, text: string, heightCm: number): number {
  const w = WIDTHS[fontId] ?? WIDTHS["tc-egen-kantig"]!;
  const sum = [...text].reduce((s, ch) => s + ((w as any)[ch] ?? w.d), 0);
  return (sum + FIGURE_GAP * Math.max(0, text.length - 1)) * heightCm;
}

/** Shopify colour names of the shirts we sell, for swatches and the preview. */
const SHIRT_HEX: Record<string, string> = {
  vit: "#f3f3f1",
  white: "#f3f3f1",
  svart: "#161616",
  black: "#161616",
  "royalblå": "#1f62c4",
  "mörk marin": "#24304a",
  marin: "#24304a",
  "röd": "#c8202f",
  red: "#c8202f",
};
const shirtHex = (name: string) => SHIRT_HEX[name.toLowerCase()] ?? "#9a9ca0";

const PLACES = [
  { id: "back", label: "Rygg, över numret" },
  { id: "chest", label: "Bröst" },
  { id: "sleeve", label: "Ärm" },
] as const;
type Place = (typeof PLACES)[number]["id"];

interface Upload {
  file: File;
  url: string | null;
}

interface Sponsor {
  id: string;
  upload: Upload | null;
  place: Place;
  widthCm: number;
  qty: number;
}

const ACCEPT = "image/png,image/jpeg,image/svg+xml,application/pdf,.eps,.ai";

function toUpload(file: File): Upload {
  return { file, url: /^image\//.test(file.type) ? URL.createObjectURL(file) : null };
}

function useWide(ref: React.RefObject<HTMLElement | null>, min = 900) {
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

export function TeamBuilder({ data }: { data: TeamData }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const wide = useWide(rootRef);
  const shirt = data.shirt;

  const colors = useMemo(() => [...new Set(shirt?.variants.map((v) => v.color) ?? [])], [shirt]);
  const sizes = useMemo(() => [...new Set(shirt?.variants.map((v) => v.size) ?? [])], [shirt]);
  const [color, setColor] = useState(colors[0] ?? "");
  const [qty, setQty] = useState<Record<string, number>>({});

  const [clubId, setClubId] = useState<string | null>(null);
  const [ownLogo, setOwnLogo] = useState<Upload | null>(null);
  const [ownName, setOwnName] = useState("");
  const [query, setQuery] = useState("");
  const [logoQty, setLogoQty] = useState(0);
  const [logoFollows, setLogoFollows] = useState(true);

  const [styleId, setStyleId] = useState(STYLES[0]!.id);
  const [heightCm, setHeightCm] = useState(20);
  const [ink, setInk] = useState("#ffffff");
  const [players, setPlayers] = useState("");
  const [ownNumbers, setOwnNumbers] = useState("");
  const [digits, setDigits] = useState<number[]>(Array(10).fill(0));
  const [previewNumber, setPreviewNumber] = useState("10");
  const [previewSize, setPreviewSize] = useState<string | null>(null);

  const [sponsors, setSponsors] = useState<Sponsor[]>([]);
  const [progress, setProgress] = useState<OrderProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState(false);
  const [fontsReady, setFontsReady] = useState(false);

  const style = STYLES.find((s) => s.id === styleId) ?? STYLES[0]!;
  const family = fontFamily(fontById(style.fontId));

  useEffect(() => {
    void Promise.all(STYLES.map((s) => loadFont(fontById(s.fontId)))).then(() => setFontsReady(true));
  }, []);

  const shirtCount = sizes.reduce((n, s) => n + (qty[s] || 0), 0);
  useEffect(() => {
    if (logoFollows) setLogoQty(shirtCount);
  }, [shirtCount, logoFollows]);

  // White shirts get black figures; picking a dark shirt again brings white back.
  const pickColor = (c: string) => {
    setColor(c);
    const hex = shirtHex(c);
    if (ink === "#ffffff" && contrastOf(hex) === "#111111") setInk("#111111");
    if (ink === "#111111" && contrastOf(hex) === "#ffffff") setInk("#ffffff");
  };

  const club: Club | null = data.clubs.find((c) => c.id === clubId) ?? null;
  const hasLogo = Boolean(club || ownLogo);
  const logoName = club?.name || ownName.trim() || "Föreningens logga";
  const logoWidthCm = club?.widthCm ?? 7;
  const logoSrc = club?.logo ?? ownLogo?.url ?? null;

  const filteredClubs = useMemo(() => {
    const q = query.trim().toLocaleLowerCase("sv-SE");
    if (!q) return data.clubs;
    return data.clubs.filter((c) => [c.name, c.city, c.sport].join(" ").toLocaleLowerCase("sv-SE").includes(q));
  }, [data.clubs, query]);

  // The digits follow the number of players as it is typed: 1-15 needs
  // eight ones and one of every other figure.
  const fromPlayers = (value: string) => {
    setPlayers(value);
    const n = Math.max(0, Math.min(99, parseInt(value, 10) || 0));
    if (!n) return;
    setOwnNumbers("");
    setError(null);
    const numbers = Array.from({ length: n }, (_, i) => String(i + 1));
    setDigits(countDigits(numbers));
    setPreviewNumber(numbers.find((x) => x.length === 2) ?? numbers[0]!);
  };

  // A team's own numbers ("1, 4, 7, 23") are used when asked, not while typing.
  const fromOwnNumbers = () => {
    const numbers = parseNumbers(ownNumbers);
    if (numbers.length === 0) {
      setError("Skriv era nummer, till exempel 1, 4, 7, 23.");
      return;
    }
    setError(null);
    setPlayers("");
    setDigits(countDigits(numbers));
    setPreviewNumber(numbers.find((x) => x.length === 2) ?? numbers[0]!);
  };

  // Prices
  const digitPrice = data.prices.get(digitKey(heightCm)) ?? null;
  const logoPrice = (widthCm: number) => data.prices.get(logoKey(widthCm)) ?? null;
  const variantFor = (size: string) => shirt?.variants.find((v) => v.color === color && v.size === size) ?? null;

  const digitCount = digits.reduce((a, b) => a + b, 0);
  const lines: { label: string; detail: string; qty: number; unit: number }[] = [];
  for (const s of sizes) {
    const v = variantFor(s);
    if (v && qty[s]) lines.push({ label: `${shirt!.title}, ${color}`, detail: s, qty: qty[s]!, unit: v.price });
  }
  if (digitCount && digitPrice) lines.push({ label: `Siffror ${heightCm} cm, ${style.label.toLowerCase()}`, detail: COLORS.find((c) => c.value === ink)?.label ?? "", qty: digitCount, unit: digitPrice.price });
  if (hasLogo && logoQty) {
    const p = logoPrice(logoWidthCm);
    if (p) lines.push({ label: `Klubbmärke ${logoName}`, detail: `${String(logoWidthCm).replace(".", ",")} cm bred`, qty: logoQty, unit: p.price });
  }
  sponsors.forEach((sp, i) => {
    const p = logoPrice(sp.widthCm);
    if (p && sp.qty && sp.upload) lines.push({ label: `Sponsorlogga ${i + 1}`, detail: `${sp.widthCm} cm, ${PLACES.find((x) => x.id === sp.place)!.label.toLowerCase()}`, qty: sp.qty, unit: p.price });
  });
  const subtotal = lines.reduce((s, l) => s + l.qty * l.unit, 0);
  const missingPrices = (digitCount > 0 && !digitPrice) || (hasLogo && logoQty > 0 && !logoPrice(logoWidthCm));
  const sponsorsWithoutFile = sponsors.some((s) => s.qty > 0 && !s.upload);
  const canOrder = subtotal > 0 && !missingPrices && !sponsorsWithoutFile && !progress;

  const smallest = sizes.find((s) => qty[s]) ?? sizes[0] ?? "130/140";
  // The preview follows the smallest size ordered until a size is picked under it.
  const shownSize = previewSize && sizes.includes(previewSize) ? previewSize : smallest;
  const packshot = variantFor(shownSize) ?? shirt?.variants.find((v) => v.color === color) ?? null;
  const chart = SIZE_CHART[smallest] ?? SIZE_CHART["130/140"]!;
  const twoWide = numberWidthCm(style.fontId, "88", heightCm);
  const tooWide = twoWide > chart.chest * 0.75;

  const order = async () => {
    if (!canOrder || !shirt) return;
    setError(null);
    setProgress({ step: "draw", done: 0, total: 1 });
    try {
      const pieces: Piece[] = [];
      const common = { Lag: club?.name || ownName.trim() || "" };
      digits.forEach((count, d) => {
        if (!count || !digitPrice) return;
        pieces.push({
          key: `digit|${style.fontId}|${heightCm}|${ink}|${d}`,
          kind: "digit",
          label: String(d),
          count,
          price: digitPrice,
          spec: { text: String(d), fontId: style.fontId, color: ink, outline: 0, outlineColor: "#111111", align: "center" },
          heightCm,
          properties: {
            ...(common.Lag ? common : {}),
            Stil: `${style.label}, ${heightCm} cm`,
            Färg: COLORS.find((c) => c.value === ink)?.label ?? ink,
            Siffror: digits.map((n, i) => (n ? `${n} st ${i}` : "")).filter(Boolean).join(", "),
          },
        });
      });
      if (hasLogo && logoQty) {
        const p = logoPrice(logoWidthCm)!;
        const src = club?.logo;
        pieces.push({
          key: `logo|club|${club?.id ?? "own"}`,
          kind: "logo",
          label: logoName,
          count: logoQty,
          price: p,
          widthCm: logoWidthCm,
          file: src ? () => fileFromUrl(src, logoName) : async () => ownLogo!.file,
          properties: { Logga: `Klubbmärke ${logoName}`, Bredd: `${String(logoWidthCm).replace(".", ",")} cm`, Placering: "Bröst" },
        });
      }
      sponsors.forEach((sp, i) => {
        const p = logoPrice(sp.widthCm);
        if (!p || !sp.qty || !sp.upload) return;
        const file = sp.upload.file;
        pieces.push({
          key: `logo|sponsor|${sp.id}`,
          kind: "logo",
          label: `Sponsor ${i + 1}`,
          count: sp.qty,
          price: p,
          widthCm: sp.widthCm,
          file: async () => file,
          properties: {
            ...(common.Lag ? common : {}),
            Logga: `Sponsor ${i + 1} (${file.name})`,
            Bredd: `${sp.widthCm} cm`,
            Placering: PLACES.find((x) => x.id === sp.place)!.label,
          },
        });
      });
      const shirtsInCart = sizes
        .map((s) => ({ variantId: variantFor(s)?.id ?? "", quantity: qty[s] || 0 }))
        .filter((s) => s.variantId && s.quantity > 0);
      await orderTeam(pieces, shirtsInCart, setProgress);
      setAdded(true);
      const root = (window as any).Shopify?.routes?.root || "/";
      window.setTimeout(() => (window.location.href = `${root}cart`), 1200);
    } catch (err) {
      setError((err as Error).message);
      setProgress(null);
    }
  };

  if (!shirt) {
    return <div style={S.error}>Välj en tröja i blockets inställningar ("Tröja").</div>;
  }

  const summary = (
    <div style={S.summary}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 14 }}>
        {lines.length === 0 && <div style={S.small}>Välj tröjor och siffror så räknas priset fram här.</div>}
        {lines.map((l, i) => (
          <div key={i} style={S.sumRow}>
            <span style={{ minWidth: 0 }}>
              {l.label}
              <span style={{ ...S.small, display: "block" }}>
                {l.qty} × {kr(l.unit)}
                {l.detail ? ` · ${l.detail}` : ""}
              </span>
            </span>
            <span style={{ whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{kr(Math.round(l.qty * l.unit * 100) / 100)}</span>
          </div>
        ))}
      </div>
      <div style={{ borderTop: `1px solid ${LINE}`, marginTop: 12, paddingTop: 12, display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={S.sumRow}>
          <span>Summa exkl. moms</span>
          <strong style={{ fontVariantNumeric: "tabular-nums" }}>{kr(Math.round(subtotal * 100) / 100)}</strong>
        </div>
        <div style={{ ...S.sumRow, ...S.small }}>
          <span>Inkl. moms</span>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>{kr(Math.round(subtotal * (1 + VAT) * 100) / 100)}</span>
        </div>
        {shirtCount > 0 && (
          <div style={S.small}>{kr(Math.round((subtotal * (1 + VAT)) / shirtCount))} per spelare inkl. moms</div>
        )}
      </div>
      {missingPrices && <div style={S.error}>Den här storleken saknar pris. Välj en annan.</div>}
      {sponsorsWithoutFile && <div style={S.error}>Ladda upp sponsorloggan, eller ta bort raden.</div>}
      <button type="button" onClick={() => void order()} disabled={!canOrder} style={{ ...S.primary, marginTop: 14, ...(canOrder ? null : S.primaryOff) }}>
        {progress ? "Förbereder…" : "Lägg i varukorgen"}
      </button>
      <div style={{ ...S.small, marginTop: 8, textAlign: "center" }}>Vi granskar loggorna innan tryck. Ni pressar själva på 15 sekunder.</div>
    </div>
  );

  return (
    <div ref={rootRef} style={S.root}>
      <div style={{ display: "grid", gridTemplateColumns: wide ? "minmax(0, 1.15fr) minmax(0, 0.85fr)" : "minmax(0, 1fr)", gap: wide ? 36 : 18, alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
          {/* On a phone the shirt is a reminder above the steps, not the page. */}
          {!wide && (
            <div style={{ maxWidth: 360, width: "100%", margin: "0 auto" }}>
              <Preview
                shirtColor={shirtHex(color)}
                front={packshot?.front ?? null}
                back={packshot?.back ?? null}
                ink={ink}
                family={family}
                heightCm={heightCm}
                number={previewNumber}
                onNumber={setPreviewNumber}
                size={shownSize}
                sizes={sizes}
                onSize={setPreviewSize}
                logo={hasLogo ? { src: logoSrc, widthCm: logoWidthCm } : null}
                sponsors={sponsors}
              />
            </div>
          )}
          <Step n={1} title="Tröja" aside={`${shirtCount} st`}>
            <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
              {variantFor(sizes[0] ?? "")?.image && (
                <img src={variantFor(sizes[0]!)!.image!} alt="" style={{ width: 76, height: 95, objectFit: "cover", borderRadius: 10, background: SOFT, flexShrink: 0 }} />
              )}
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 700 }}>
                  {shirt.vendor ? `${shirt.vendor} ` : ""}
                  {shirt.title}
                </div>
                <div style={S.small}>Funktions-t-shirt i polyester · {kr(variantFor(sizes[0] ?? "")?.price ?? 0)} exkl. moms</div>
                {shirt.url && (
                  <a href={shirt.url} style={{ ...S.link, fontSize: 12.5 }}>
                    Mått och material
                  </a>
                )}
              </div>
            </div>
            <div style={{ ...S.row, marginTop: 14 }}>
              <span style={S.fieldLabel}>Färg</span>
              <div style={S.swatches}>
                {colors.map((c) => (
                  <button
                    key={c}
                    type="button"
                    title={c}
                    aria-label={c}
                    aria-pressed={c === color}
                    onClick={() => pickColor(c)}
                    style={{ ...S.swatch, background: shirtHex(c), boxShadow: c === color ? `0 0 0 2px #fff, 0 0 0 4px ${ACCENT}` : "none" }}
                  />
                ))}
              </div>
              <span style={S.small}>{color}</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(3, sizes.length)}, minmax(0, 1fr))`, gap: 8, marginTop: 12 }}>
              {sizes.map((s) => (
                <label key={s} style={S.qtyBox}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{s}</span>
                  <Stepper value={qty[s] || 0} onChange={(v) => setQty((q) => ({ ...q, [s]: v }))} label={`Antal i ${s}`} />
                </label>
              ))}
            </div>
          </Step>

          <Step n={2} title="Förening" aside="Valfritt">
            <div style={S.row}>
              <button
                type="button"
                aria-pressed={!clubId && !ownLogo}
                onClick={() => {
                  setClubId(null);
                  setOwnLogo(null);
                }}
                style={{ ...S.chip, ...(!clubId && !ownLogo ? S.chipOn : null) }}
              >
                Ingen förening
              </button>
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Sök förening, ort eller idrott"
                aria-label="Sök förening"
                style={{ ...S.input, flex: "1 1 200px" }}
              />
            </div>
            <div style={S.clubList} role="listbox" aria-label="Föreningar">
              {filteredClubs.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="option"
                  aria-selected={c.id === clubId}
                  onClick={() => {
                    setClubId(c.id);
                    setOwnLogo(null);
                  }}
                  style={{ ...S.clubRow, ...(c.id === clubId ? S.cardOn : null) }}
                >
                  {c.logo ? <img src={c.logo} alt="" style={{ width: 36, height: 40, objectFit: "contain", flexShrink: 0 }} /> : <span style={S.noLogo}>{c.name[0]}</span>}
                  <span style={{ minWidth: 0, textAlign: "left" }}>
                    <span style={{ display: "block", fontWeight: 600, fontSize: 14 }}>{c.name}</span>
                    <span style={S.small}>{[c.sport, c.city].filter(Boolean).join(" · ")}</span>
                  </span>
                </button>
              ))}
              {filteredClubs.length === 0 && <div style={{ ...S.small, padding: 8 }}>Ingen förening matchar "{query}".</div>}
            </div>
            <div style={{ ...S.small, marginTop: 10 }}>
              Hittar ni inte er förening?{" "}
              <label style={{ ...S.link, cursor: "pointer" }}>
                Ladda upp er logga
                <input
                  type="file"
                  accept={ACCEPT}
                  hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    setOwnLogo(toUpload(f));
                    setClubId(null);
                    e.target.value = "";
                  }}
                />
              </label>
            </div>
            {ownLogo && (
              <div style={{ ...S.row, marginTop: 10 }}>
                <span style={S.thumb}>{ownLogo.url ? <img src={ownLogo.url} alt="" style={{ maxWidth: "100%", maxHeight: "100%" }} /> : "Fil"}</span>
                <input type="text" value={ownName} onChange={(e) => setOwnName(e.target.value)} placeholder="Föreningens namn" aria-label="Föreningens namn" style={{ ...S.input, flex: "1 1 180px" }} />
              </div>
            )}
            {hasLogo && (
              <div style={{ ...S.row, marginTop: 12 }}>
                <span style={S.fieldLabel}>Klubbmärken</span>
                <div style={{ width: 140 }}>
                <Stepper
                  value={logoQty}
                  onChange={(v) => {
                    setLogoFollows(false);
                    setLogoQty(v);
                  }}
                  label="Antal klubbmärken"
                />
                </div>
                <span style={S.small}>
                  {String(logoWidthCm).replace(".", ",")} cm på bröstet
                  {logoPrice(logoWidthCm) ? ` · ${kr(logoPrice(logoWidthCm)!.price)}/st` : ""}
                </span>
              </div>
            )}
          </Step>

          <Step n={3} title="Siffror" aside={`${digitCount} st${digitPrice ? ` · ${kr(digitPrice.price)}/st` : ""}`}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
              {STYLES.map((s) => (
                <button key={s.id} type="button" aria-pressed={s.id === styleId} onClick={() => setStyleId(s.id)} style={{ ...S.card, ...(s.id === styleId ? S.cardOn : null) }}>
                  <span style={{ ...S.styleSample, background: shirtHex(color), color: ink, fontFamily: `"${fontFamily(fontById(s.fontId))}", sans-serif`, opacity: fontsReady ? 1 : 0.3 }}>13</span>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{s.label}</span>
                </button>
              ))}
            </div>
            <div style={{ ...S.row, marginTop: 12 }}>
              <span style={S.fieldLabel}>Höjd</span>
              <div style={{ display: "flex", gap: 6 }}>
                {DIGIT_HEIGHTS_CM.map((h) => {
                  const p = data.prices.get(digitKey(h));
                  return (
                    <button key={h} type="button" aria-pressed={h === heightCm} onClick={() => setHeightCm(h)} style={{ ...S.chip, ...(h === heightCm ? S.chipOn : null) }}>
                      <span style={{ fontWeight: 600 }}>{h} cm</span>
                      {p && <span style={{ fontSize: 11.5, opacity: 0.75 }}>{kr(p.price)}/st</span>}
                    </button>
                  );
                })}
              </div>
            </div>
            <div style={{ ...S.row, marginTop: 12 }}>
              <span style={S.fieldLabel}>Färg</span>
              <div style={S.swatches}>
                {COLORS.map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    title={c.label}
                    aria-label={`Siffror: ${c.label}`}
                    aria-pressed={c.value === ink}
                    onClick={() => setInk(c.value)}
                    style={{ ...S.swatchSmall, background: c.value, boxShadow: c.value === ink ? `0 0 0 2px #fff, 0 0 0 4px ${ACCENT}` : "none" }}
                  />
                ))}
              </div>
            </div>
            {tooWide && (
              <div style={{ ...S.note, marginTop: 12 }}>
                Två siffror i {heightCm} cm blir ca {Math.round(twoWide)} cm breda, nästan hela ryggen på {smallest}. Vi rekommenderar 20 cm.
              </div>
            )}
            <div style={{ display: "grid", gridTemplateColumns: wide ? "120px minmax(0, 1fr) auto" : "minmax(0, 1fr)", gap: 8, alignItems: "end", marginTop: 14 }}>
              <label style={S.field}>
                <span style={S.fieldTop}>Antal spelare</span>
                <input type="number" min={1} max={99} inputMode="numeric" value={players} onChange={(e) => fromPlayers(e.target.value)} placeholder="15" aria-label="Antal spelare" style={S.input} />
              </label>
              <label style={S.field}>
                <span style={S.fieldTop}>eller era nummer</span>
                <input
                  type="text"
                  value={ownNumbers}
                  onChange={(e) => setOwnNumbers(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && fromOwnNumbers()}
                  placeholder="1, 4, 7, 10, 23"
                  aria-label="Era egna nummer"
                  style={S.input}
                />
              </label>
              <button type="button" onClick={fromOwnNumbers} style={S.secondaryBtn}>
                Använd numren
              </button>
            </div>
            <div style={{ ...S.small, marginTop: 6 }}>Siffrorna räknas ut direkt när ni skriver antal spelare: 1-15 behöver 21 siffror, åtta ettor och en av varje annan. Har ni egna nummer, skriv dem och klicka Använd numren. Antalet under varje siffra går att ändra.</div>
            <div style={{ display: "grid", gridTemplateColumns: `repeat(${wide ? 5 : 3}, minmax(0, 1fr))`, gap: 8, marginTop: 12 }}>
              {digits.map((n, d) => (
                <div key={d} style={S.digit}>
                  <span style={{ ...S.digitTile, background: shirtHex(color), color: ink, fontFamily: `"${family}", sans-serif`, opacity: fontsReady ? 1 : 0.3 }}>{d}</span>
                  <Stepper value={n} onChange={(v) => setDigits((ds) => ds.map((x, i) => (i === d ? v : x)))} label={`Antal av siffran ${d}`} />
                </div>
              ))}
            </div>
          </Step>

          <Step n={4} title="Sponsorloggor" aside="Tillval">
            <div style={S.small}>Ladda upp sponsorernas loggor, välj plats och bredd. PNG med genomskinlig bakgrund eller PDF ger bäst resultat.</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
              {sponsors.map((sp, i) => (
                <div key={sp.id} style={{ ...S.sponsorRow, gridTemplateColumns: wide ? "56px minmax(0, 1.2fr) minmax(0, 1fr) 118px 28px" : "56px minmax(0, 1fr) 28px" }}>
                  <label style={{ ...S.thumb, cursor: "pointer" }} title="Ladda upp logga">
                    {sp.upload?.url ? <img src={sp.upload.url} alt="" style={{ maxWidth: "100%", maxHeight: "100%" }} /> : sp.upload ? "Fil" : "Ladda upp"}
                    <input
                      type="file"
                      accept={ACCEPT}
                      hidden
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (!f) return;
                        setSponsors((ss) => ss.map((x) => (x.id === sp.id ? { ...x, upload: toUpload(f) } : x)));
                        e.target.value = "";
                      }}
                    />
                  </label>
                  <select
                    value={sp.place}
                    aria-label={`Placering sponsor ${i + 1}`}
                    onChange={(e) => {
                      const place = e.target.value as Place;
                      setSponsors((ss) => ss.map((x) => (x.id === sp.id ? { ...x, place, widthCm: place === "sleeve" ? 8 : x.widthCm } : x)));
                    }}
                    style={S.input}
                  >
                    {PLACES.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                  <select
                    value={sp.widthCm}
                    aria-label={`Bredd sponsor ${i + 1}`}
                    onChange={(e) => setSponsors((ss) => ss.map((x) => (x.id === sp.id ? { ...x, widthCm: +e.target.value } : x)))}
                    style={{ ...S.input, ...(wide ? null : { gridColumn: "2 / 3" }) }}
                  >
                    {LOGO_WIDTHS_CM.filter((w) => sp.place !== "sleeve" || w <= 8).map((w) => (
                      <option key={w} value={w}>
                        {w} cm bred{data.prices.get(logoKey(w)) ? ` · ${kr(data.prices.get(logoKey(w))!.price)}` : ""}
                      </option>
                    ))}
                  </select>
                  <div style={wide ? undefined : { gridColumn: "2 / 3" }}>
                    <Stepper value={sp.qty} onChange={(v) => setSponsors((ss) => ss.map((x) => (x.id === sp.id ? { ...x, qty: v } : x)))} label={`Antal sponsor ${i + 1}`} />
                  </div>
                  <button type="button" aria-label={`Ta bort sponsor ${i + 1}`} onClick={() => setSponsors((ss) => ss.filter((x) => x.id !== sp.id))} style={{ ...S.remove, ...(wide ? null : { gridRow: "1 / 2", gridColumn: "3 / 4" }) }}>
                    ×
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setSponsors((ss) => [...ss, { id: Math.random().toString(36).slice(2), upload: null, place: "back", widthCm: 15, qty: shirtCount || 1 }])}
              style={{ ...S.secondaryBtn, marginTop: 10 }}
            >
              + Lägg till sponsorlogga
            </button>
          </Step>
          {!wide && summary}
          {error && <div style={S.error}>{error}</div>}
        </div>

        {wide && (
          <div style={{ alignSelf: "stretch" }}>
            <div style={{ position: "sticky", top: 96, display: "flex", flexDirection: "column", gap: 14 }}>
              <Preview
                shirtColor={shirtHex(color)}
                front={packshot?.front ?? null}
                back={packshot?.back ?? null}
                ink={ink}
                family={family}
                heightCm={heightCm}
                number={previewNumber}
                onNumber={setPreviewNumber}
                size={shownSize}
                sizes={sizes}
                onSize={setPreviewSize}
                logo={hasLogo ? { src: logoSrc, widthCm: logoWidthCm } : null}
                sponsors={sponsors}
              />
              {summary}
            </div>
          </div>
        )}
      </div>

      {progress && (
        <div style={S.backdrop} role="dialog" aria-modal="true" aria-label="Lägger i varukorgen">
          <div style={S.modal}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, fontWeight: 700 }}>
              {!added && <span style={S.spinner} />}
              {added ? "Klart! Tar dig till varukorgen…" : progress.step === "upload" ? `Förbereder tryck ${progress.done} av ${progress.total}` : progress.step === "sheet" ? "Lägger allt på ett ark…" : progress.step === "cart" ? "Lägger i varukorgen…" : "Ritar siffrorna…"}
            </div>
            <div style={{ ...S.small, marginTop: 8 }}>Siffrorna och loggorna läggs på ett gemensamt ark som trycks och klipps ut åt er.</div>
          </div>
        </div>
      )}
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

function Stepper({ value, onChange, label }: { value: number; onChange: (v: number) => void; label: string }) {
  return (
    <div style={S.stepper}>
      <button type="button" aria-label={`Minska: ${label}`} onClick={() => onChange(Math.max(0, value - 1))} style={S.stepBtn}>
        −
      </button>
      <input
        type="number"
        min={0}
        inputMode="numeric"
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Math.max(0, Math.min(999, parseInt(e.target.value, 10) || 0)))}
        style={S.stepInput}
      />
      <button type="button" aria-label={`Öka: ${label}`} onClick={() => onChange(value + 1)} style={S.stepBtn}>
        +
      </button>
    </div>
  );
}

/**
 * Back and front of the shirt to scale, on the shirt's own packshots when
 * it has them. Those are ghost-mannequin shots: the body is round, so its
 * visible width says little, but collar to hem is the size chart's length
 * on 98 % of the picture's height. That length sets the scale, and a 20 cm
 * figure on 110/120 takes the room it will.
 *
 * Without packshots a flat shirt is drawn instead, 220 units across the
 * half chest.
 */
const PACK = {
  w: 760,
  h: 1000,
  /** Collar top and the share of the height from collar to hem. */
  collar: 12,
  length: 0.98,
  /** Figures start this share of the length below the collar, the club logo this share. */
  numberAt: 0.19,
  logoAt: 0.2,
  /** Centre of the club logo across the picture (the wearer's left chest). */
  logoX: 0.645,
};

function Preview({
  shirtColor,
  front,
  back,
  ink,
  family,
  heightCm,
  number,
  onNumber,
  size,
  sizes,
  onSize,
  logo,
  sponsors,
}: {
  shirtColor: string;
  front: string | null;
  back: string | null;
  ink: string;
  family: string;
  heightCm: number;
  number: string;
  onNumber: (v: string) => void;
  size: string;
  sizes: string[];
  onSize: (v: string) => void;
  logo: { src: string | null; widthCm: number } | null;
  sponsors: Sponsor[];
}) {
  const chart = SIZE_CHART[size] ?? SIZE_CHART["130/140"]!;
  const photos = Boolean(front && back);
  // Units per cm and where the shirt starts, in the viewBox.
  const W = photos ? PACK.w : 400;
  const top = photos ? PACK.collar : 34;
  const u = photos ? (PACK.h * PACK.length) / chart.length : 220 / chart.chest;
  const hem = top + chart.length * u;
  const viewH = photos ? PACK.h : Math.ceil(hem + 8);
  const cx = W / 2;

  const stroke = contrastOf(shirtColor) === "#111111" ? "rgba(0,0,0,0.18)" : "rgba(0,0,0,0.3)";
  const body = `M152,${top} C170,${top + 14} 230,${top + 14} 248,${top} L330,${top + 26} L384,${top + 98} L336,${top + 126} L310,${top + 102} L310,${hem} L90,${hem} L90,${top + 102} L64,${top + 126} L16,${top + 98} L70,${top + 26} Z`;
  const drawn = (side: "back" | "front") => (
    <>
      <path d={body} fill={shirtColor} stroke={stroke} strokeWidth={2} />
      {side === "back" ? (
        <path d={`M152,${top} C170,${top + 10} 230,${top + 10} 248,${top}`} fill="none" stroke={stroke} strokeWidth={3} />
      ) : (
        <path d={`M152,${top} C170,${top + 40} 230,${top + 40} 248,${top}`} fill="rgba(0,0,0,0.12)" stroke={stroke} strokeWidth={2} />
      )}
    </>
  );

  const backSponsor = sponsors.find((s) => s.place === "back" && s.qty > 0);
  const chest = sponsors.find((s) => s.place === "chest" && s.qty > 0);
  const sleeve = sponsors.find((s) => s.place === "sleeve" && s.qty > 0);
  const sponsorBox = (sp: Sponsor, x: number, y: number, extra?: string) => {
    const w = sp.widthCm * u;
    const h = w * 0.4;
    return sp.upload?.url ? (
      <image href={sp.upload.url} x={x - w / 2} y={y} width={w} height={h} preserveAspectRatio="xMidYMid meet" transform={extra} />
    ) : (
      <g transform={extra}>
        <rect x={x - w / 2} y={y} width={w} height={h} rx={3} fill="none" stroke={ink} strokeDasharray="6 4" strokeWidth={photos ? 3 : 1} opacity={0.8} />
        <text x={x} y={y + h / 2 + h * 0.15} textAnchor="middle" fontSize={Math.min(photos ? 30 : 12, h * 0.45)} fill={ink} opacity={0.85} fontFamily="inherit">
          SPONSOR
        </text>
      </g>
    );
  };

  let numberTop = top + PACK.numberAt * chart.length * u;
  const sponsorTop = top + 0.11 * chart.length * u;
  if (backSponsor) numberTop = Math.max(numberTop, sponsorTop + backSponsor.widthCm * u * 0.4 + 2 * u);
  const digitsH = heightCm * u;
  const logoTop = top + PACK.logoAt * chart.length * u;
  const logoX = photos ? W * PACK.logoX : 255;
  const shown = number.replace(/\D/g, "").slice(0, 2);

  return (
    <div style={S.previewCard}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
        <figure style={{ margin: 0, textAlign: "center" }}>
          <svg viewBox={`0 0 ${W} ${viewH}`} style={{ width: "100%", height: "auto", display: "block" }} role="img" aria-label="Tröjans baksida">
            {photos ? <image href={back!} x={0} y={0} width={W} height={PACK.h} preserveAspectRatio="xMidYMin meet" /> : drawn("back")}
            {backSponsor && sponsorBox(backSponsor, cx, sponsorTop)}
            <text x={cx} y={numberTop + digitsH} textAnchor="middle" fontSize={digitsH / 0.7} fill={ink} fontFamily={`"${family}", sans-serif`}>
              {shown}
            </text>
          </svg>
          <figcaption style={S.small}>Bak</figcaption>
        </figure>
        <figure style={{ margin: 0, textAlign: "center" }}>
          <svg viewBox={`0 0 ${W} ${viewH}`} style={{ width: "100%", height: "auto", display: "block" }} role="img" aria-label="Tröjans framsida">
            {photos ? <image href={front!} x={0} y={0} width={W} height={PACK.h} preserveAspectRatio="xMidYMin meet" /> : drawn("front")}
            {logo &&
              (logo.src ? (
                <image href={logo.src} x={logoX - (logo.widthCm * u) / 2} y={logoTop} width={logo.widthCm * u} height={logo.widthCm * u * 1.2} preserveAspectRatio="xMidYMin meet" />
              ) : (
                <circle cx={logoX} cy={logoTop + (logo.widthCm * u) / 2} r={(logo.widthCm * u) / 2} fill="none" stroke={ink} strokeDasharray="6 4" strokeWidth={photos ? 3 : 1} />
              ))}
            {chest && sponsorBox(chest, cx, top + 0.36 * chart.length * u)}
            {sleeve && (photos ? sponsorBox(sleeve, W * 0.1, PACK.h * 0.2, `rotate(-62 ${W * 0.1} ${PACK.h * 0.22})`) : sponsorBox(sleeve, 52, top + 64, `rotate(-52 52 ${top + 70})`))}
          </svg>
          <figcaption style={S.small}>Fram</figcaption>
        </figure>
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
          Visa nummer
          <input type="text" inputMode="numeric" maxLength={2} value={number} onChange={(e) => onNumber(e.target.value)} style={{ ...S.input, width: 64, padding: "6px 8px" }} />
        </label>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }} role="group" aria-label="Visa på storlek">
          <span style={S.small}>Storlek</span>
          {sizes.map((s) => (
            <button key={s} type="button" aria-pressed={s === size} onClick={() => onSize(s)} style={{ ...S.sizeChip, ...(s === size ? S.sizeChipOn : null) }}>
              {s}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  root: { fontFamily: "inherit", color: INK, width: "100%" },
  previewCard: { background: SOFT, borderRadius: 18, padding: 14 },
  small: { fontSize: 12.5, color: MUTED, lineHeight: 1.45 },
  step: { border: `1px solid ${LINE}`, borderRadius: 16, padding: "16px 16px 18px", background: "#fff" },
  stepHead: { display: "flex", alignItems: "center", gap: 10, marginBottom: 12 },
  stepNo: { width: 24, height: 24, borderRadius: "50%", background: INK, color: "#fff", fontSize: 12, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 },
  stepTitle: { margin: 0, fontSize: 15, fontWeight: 700, letterSpacing: "0.01em" },
  row: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
  fieldLabel: { fontSize: 13, fontWeight: 600, minWidth: 60 },
  field: { display: "flex", flexDirection: "column", gap: 4, minWidth: 0 },
  fieldTop: { fontSize: 12, fontWeight: 600, color: MUTED },
  swatches: { display: "flex", gap: 8, flexWrap: "wrap" },
  swatch: { width: 30, height: 30, borderRadius: "50%", border: "1px solid rgba(0,0,0,0.18)", padding: 0, cursor: "pointer" },
  swatchSmall: { width: 22, height: 22, borderRadius: "50%", border: "1px solid rgba(0,0,0,0.18)", padding: 0, cursor: "pointer" },
  link: { border: "none", background: "none", padding: 0, color: ACCENT, fontWeight: 600, cursor: "pointer", font: "inherit", textDecoration: "none" },
  card: { display: "flex", flexDirection: "column", alignItems: "center", gap: 6, padding: 10, border: `1px solid ${LINE}`, borderRadius: 12, background: "#fff", cursor: "pointer", font: "inherit", color: INK },
  cardOn: { border: `1.5px solid ${ACCENT}`, background: "rgba(220,47,60,0.05)", boxShadow: `0 0 0 1px ${ACCENT}` },
  styleSample: { width: "100%", borderRadius: 8, fontSize: 44, lineHeight: "64px", height: 64, textAlign: "center", letterSpacing: 0 },
  chip: {
    display: "inline-flex",
    flexDirection: "column",
    alignItems: "center",
    lineHeight: 1.25,
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
  input: {
    width: "100%",
    boxSizing: "border-box",
    padding: "10px 11px",
    border: "1px solid rgba(0,0,0,0.16)",
    borderRadius: 10,
    font: "inherit",
    fontSize: 16,
    color: INK,
    background: "#fff",
    minWidth: 0,
  },
  // Longhands: sizeChipOn changes only the colour.
  sizeChip: { borderWidth: 1, borderStyle: "solid", borderColor: LINE, background: "#fff", color: INK, borderRadius: 999, padding: "4px 9px", fontSize: 12, cursor: "pointer", fontFamily: "inherit" },
  sizeChipOn: { background: INK, borderColor: INK, color: "#fff", fontWeight: 600 },
  qtyBox: { display: "flex", flexDirection: "column", gap: 6, border: `1px solid ${LINE}`, borderRadius: 12, padding: 10 },
  stepper: { display: "flex", alignItems: "center", justifyContent: "space-between", border: "1px solid rgba(0,0,0,0.16)", borderRadius: 10, padding: 2, height: 40, boxSizing: "border-box", background: "#fff", minWidth: 0, width: "100%" },
  stepBtn: { width: 24, height: 32, border: "none", background: "transparent", fontSize: 18, cursor: "pointer", color: INK, fontFamily: "inherit", padding: 0, flexShrink: 0 },
  stepInput: { width: "100%", minWidth: 0, border: "none", textAlign: "center", font: "inherit", fontSize: 16, fontVariantNumeric: "tabular-nums", background: "transparent", color: INK, MozAppearance: "textfield" } as React.CSSProperties,
  clubList: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 8, marginTop: 10, maxHeight: 260, overflowY: "auto", padding: 2 },
  clubRow: { display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", border: `1px solid ${LINE}`, borderRadius: 12, background: "#fff", cursor: "pointer", font: "inherit", color: INK },
  noLogo: { width: 36, height: 36, borderRadius: "50%", background: SOFT, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, color: MUTED, flexShrink: 0 },
  thumb: { width: 56, height: 46, borderRadius: 8, background: SOFT, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", fontSize: 11, color: MUTED, textAlign: "center", flexShrink: 0 },
  digit: { display: "flex", flexDirection: "column", gap: 6, border: `1px solid ${LINE}`, borderRadius: 12, padding: 6 },
  digitTile: { display: "block", borderRadius: 8, fontSize: 52, lineHeight: "76px", height: 76, textAlign: "center" },
  sponsorRow: { display: "grid", gap: 8, alignItems: "center", border: `1px solid ${LINE}`, borderRadius: 12, padding: 8 },
  remove: { width: 28, height: 32, border: "none", background: "transparent", color: "#a1a1a6", fontSize: 20, cursor: "pointer", padding: 0 },
  secondaryBtn: { border: "1px solid rgba(0,0,0,0.16)", background: "#fff", borderRadius: 10, padding: "10px 14px", cursor: "pointer", font: "inherit", fontSize: 13.5, fontWeight: 600, color: INK, height: 44 },
  note: { padding: "10px 12px", borderRadius: 10, background: "#fff8e6", border: "1px solid #f5d48a", color: "#7a4b00", fontSize: 13 },
  summary: { border: `1px solid ${LINE}`, borderRadius: 16, padding: 16, background: "#fff", boxShadow: "0 8px 30px rgba(0,0,0,0.06)" },
  sumRow: { display: "flex", justifyContent: "space-between", gap: 10 },
  primary: { width: "100%", border: "none", borderRadius: 12, background: ACCENT, color: "#fff", padding: "15px 16px", fontWeight: 700, fontSize: 15, cursor: "pointer", font: "inherit" },
  primaryOff: { background: "#e8e8ea", color: "#8e8e93", cursor: "not-allowed" },
  error: { marginTop: 10, padding: "10px 12px", borderRadius: 10, background: "#fff4ed", border: "1px solid #fed7aa", color: "#9a3412", fontSize: 13.5 },
  backdrop: { position: "fixed", inset: 0, background: "rgba(17,17,20,0.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 2147483000 },
  modal: { width: "100%", maxWidth: 400, background: "#fff", borderRadius: 18, padding: 22, boxShadow: "0 24px 80px rgba(0,0,0,0.25)", fontFamily: "inherit" },
  spinner: { display: "inline-block", width: 14, height: 14, borderRadius: "50%", border: `2px solid ${ACCENT}`, borderTopColor: "transparent", animation: "gs-nn-spin 0.8s linear infinite" },
};
