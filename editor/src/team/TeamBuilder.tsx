import { useEffect, useMemo, useRef, useState } from "react";
import { fontById, fontFamily, loadFont } from "../config/fonts";
import { contrastOf } from "../names/catalog";
import {
  DIGIT_HEIGHTS_CM,
  DIGIT_INKS,
  FRONT_HEIGHTS_CM,
  LOGO_WIDTHS_CM,
  SIZE_CHART,
  countDigits,
  digitStockKey,
  frontKey,
  kr,
  logoKey,
  parseNumbers,
  type Club,
  type TeamData,
} from "./data";
import { fileFromUrl, orderTeam, type CartLine, type OrderProgress, type Piece } from "./order";

/**
 * The team page: shirts, a club, digits and sponsors in one order.
 *
 * 1. The shirt: one colour, a quantity per size.
 * 2. The club, if any: partner clubs have their logo saved; any other club
 *    uploads its own.
 * 3. The digits 0-9, white or black from the shop's own stock: filled in
 *    from the number of players (1-15 needs eight ones) or the team's own
 *    numbers, then adjustable one by one.
 * 4. Sponsor logos, as many as the team has.
 * 5. A heat press, recommended to clubs that press for every team.
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
  { id: "chest", label: "Fram, mitten" },
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
  // The team's numbers, from the player count or typed in: one small front number each.
  const [numbers, setNumbers] = useState<string[]>([]);
  const [frontOn, setFrontOn] = useState(false);
  const [frontCm, setFrontCm] = useState(7);
  const [frontPlace, setFrontPlace] = useState<FrontPlace>("left");
  const [previewSize, setPreviewSize] = useState<string | null>(null);

  const [sponsors, setSponsors] = useState<Sponsor[]>([]);
  // One spare of every figure, for players who join during the season.
  const [spare, setSpare] = useState(false);
  const [withPress, setWithPress] = useState(false);
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
    setNumbers(numbers);
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
    setNumbers(numbers);
    setDigits(countDigits(numbers));
    setPreviewNumber(numbers.find((x) => x.length === 2) ?? numbers[0]!);
  };

  // Prices
  const inkLabel = DIGIT_INKS.find((c) => c.value === ink)?.label ?? "Vit";
  const stockDigit = (d: number, h = heightCm) => data.digits.get(digitStockKey(style.label, h, inkLabel, d)) ?? null;
  const digitPrice = stockDigit(0);
  const logoPrice = (widthCm: number) => data.prices.get(logoKey(widthCm)) ?? null;
  const variantFor = (size: string) => shirt?.variants.find((v) => v.color === color && v.size === size) ?? null;

  const orderDigits = digits.map((n) => n + (spare ? 1 : 0));
  const digitCount = orderDigits.reduce((a, b) => a + b, 0);
  const lines: { label: string; detail: string; qty: number; unit: number }[] = [];
  for (const s of sizes) {
    const v = variantFor(s);
    if (v && qty[s]) lines.push({ label: `${shirt!.title}, ${color}`, detail: s, qty: qty[s]!, unit: v.price });
  }
  if (digitCount && digitPrice) lines.push({ label: `Siffror ${heightCm} cm, ${style.label.toLowerCase()}`, detail: inkLabel, qty: digitCount, unit: digitPrice.price });
  if (hasLogo && logoQty) {
    const p = logoPrice(logoWidthCm);
    if (p) lines.push({ label: `Klubbmärke ${logoName}`, detail: `${String(logoWidthCm).replace(".", ",")} cm bred`, qty: logoQty, unit: p.price });
  }
  sponsors.forEach((sp, i) => {
    const p = logoPrice(sp.widthCm);
    if (p && sp.qty && sp.upload) lines.push({ label: `Sponsorlogga ${i + 1}`, detail: `${sp.widthCm} cm, ${PLACES.find((x) => x.id === sp.place)!.label.toLowerCase()}`, qty: sp.qty, unit: p.price });
  });
  const frontPrice = data.prices.get(frontKey(frontCm)) ?? null;
  const frontCount = frontOn ? numbers.length : 0;
  const frontLabel = frontPlace === "center" ? "mitt fram" : "vänster bröst";
  if (frontCount && frontPrice) lines.push({ label: `Nummer fram ${frontCm} cm`, detail: frontLabel, qty: frontCount, unit: frontPrice.price });
  if (withPress && data.press) lines.push({ label: `${data.press.vendor} ${data.press.title}`.trim(), detail: "Värmepress", qty: 1, unit: data.press.price });
  const subtotal = lines.reduce((s, l) => s + l.qty * l.unit, 0);
  const missingPrices =
    orderDigits.some((n, d) => n > 0 && !stockDigit(d)) || (hasLogo && logoQty > 0 && !logoPrice(logoWidthCm)) || (frontCount > 0 && !frontPrice);
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
      const team = common.Lag ? common : {};
      // The digits come from stock: a cart line per figure, so Shopify
      // counts the stock down.
      const digitLines: CartLine[] = [];
      orderDigits.forEach((count, d) => {
        const v = stockDigit(d);
        if (count && v) digitLines.push({ variantId: v.variantId, quantity: count, properties: { ...team } });
      });
      if (hasLogo && logoQty) {
        const p = logoPrice(logoWidthCm)!;
        const src = club?.logo;
        pieces.push({
          key: `logo|club|${club?.id ?? "own"}`,
          label: logoName,
          count: logoQty,
          price: p,
          widthCm: logoWidthCm,
          file: src ? () => fileFromUrl(src, logoName) : async () => ownLogo!.file,
          properties: { ...team, Logga: `Klubbmärke ${logoName}`, Bredd: `${String(logoWidthCm).replace(".", ",")} cm`, Placering: "Bröst" },
        });
      }
      if (frontCount && frontPrice) {
        for (const n of numbers) {
          pieces.push({
            key: `front|${n}`,
            line: "front",
            label: n,
            count: 1,
            price: frontPrice,
            text: { spec: { text: n, fontId: style.fontId, color: ink, outline: 0, outlineColor: "#111111", align: "center" }, heightCm: frontCm },
            properties: { ...team, Framnummer: numbers.join(", "), Stil: `${style.label}, ${inkLabel}`, Placering: frontPlace === "center" ? "Mitt fram" : "Vänster bröst" },
          });
        }
      }
      sponsors.forEach((sp, i) => {
        const p = logoPrice(sp.widthCm);
        if (!p || !sp.qty || !sp.upload) return;
        const file = sp.upload.file;
        pieces.push({
          key: `logo|sponsor|${sp.id}`,
          label: `Sponsor ${i + 1}`,
          count: sp.qty,
          price: p,
          widthCm: sp.widthCm,
          file: async () => file,
          properties: {
            ...team,
            Logga: `Sponsor ${i + 1} (${file.name})`,
            Bredd: `${sp.widthCm} cm`,
            Placering: PLACES.find((x) => x.id === sp.place)!.label,
          },
        });
      });
      const plain: CartLine[] = sizes
        .map((s) => ({ variantId: variantFor(s)?.id ?? "", quantity: qty[s] || 0, properties: { ...team } }))
        .filter((s) => s.variantId && s.quantity > 0);
      plain.push(...digitLines);
      if (withPress && data.press) plain.push({ variantId: data.press.variantId, quantity: 1 });
      await orderTeam(pieces, plain, setProgress);
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
                fontId={style.fontId}
                heightCm={heightCm}
                number={previewNumber}
                onNumber={setPreviewNumber}
                size={shownSize}
                sizes={sizes}
                onSize={setPreviewSize}
                logo={hasLogo ? { src: logoSrc, widthCm: logoWidthCm } : null}
                frontNumber={frontOn ? { heightCm: frontCm, place: frontPlace } : null}
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
                  const p = stockDigit(0, h);
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
                {DIGIT_INKS.map((c) => (
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
              <span style={S.small}>{inkLabel}, från vårt lager i Sverige</span>
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
            <label style={S.option}>
              <input type="checkbox" checked={spare} onChange={(e) => setSpare(e.target.checked)} style={{ accentColor: ACCENT, width: 18, height: 18, flexShrink: 0 }} />
              <span>
                <strong>Reservsiffror, en av varje 0-9</strong>
                <span style={{ ...S.small, display: "block" }}>
                  10 extra siffror{digitPrice ? ` för ${kr(10 * digitPrice.price)}` : ""}, för spelare som kommer till under säsongen eller en siffra som går sönder.
                </span>
              </span>
            </label>
            <div style={{ ...S.option, display: "block", cursor: "default" }}>
              <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer" }}>
                <input type="checkbox" checked={frontOn} onChange={(e) => setFrontOn(e.target.checked)} style={{ accentColor: ACCENT, width: 18, height: 18, flexShrink: 0 }} />
                <span>
                  <strong>Litet nummer fram</strong>
                  <span style={{ ...S.small, display: "block" }}>
                    Samma nummer på bröstet, tryckt i ett stycke. Bredvid klubbmärket eller mitt fram.
                  </span>
                </span>
              </label>
              {frontOn && (
                <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 10, paddingLeft: 28 }}>
                  <div style={S.row}>
                    <span style={S.fieldLabel}>Höjd</span>
                    <div style={{ display: "flex", gap: 6 }}>
                      {FRONT_HEIGHTS_CM.map((h) => {
                        const p = data.prices.get(frontKey(h));
                        return (
                          <button key={h} type="button" aria-pressed={h === frontCm} onClick={() => setFrontCm(h)} style={{ ...S.chip, ...(h === frontCm ? S.chipOn : null) }}>
                            <span style={{ fontWeight: 600 }}>{h} cm</span>
                            {p && <span style={{ fontSize: 11.5, opacity: 0.75 }}>{kr(p.price)}/st</span>}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div style={S.row}>
                    <span style={S.fieldLabel}>Plats</span>
                    <div style={{ display: "flex", gap: 6 }}>
                      {(
                        [
                          { id: "left", label: "Vänster bröst" },
                          { id: "center", label: "Mitt fram" },
                        ] as const
                      ).map((o) => (
                        <button key={o.id} type="button" aria-pressed={o.id === frontPlace} onClick={() => setFrontPlace(o.id)} style={{ ...S.chip, ...(o.id === frontPlace ? S.chipOn : null) }}>
                          {o.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <span style={S.small}>
                    {numbers.length
                      ? `${numbers.length} nummer: ${numbers.slice(0, 12).join(", ")}${numbers.length > 12 ? " …" : ""}`
                      : "Skriv antal spelare eller era nummer ovan, så trycks ett nummer per spelare."}
                  </span>
                </div>
              )}
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

          {data.press && (
            <Step n={5} title="Press" aside="Tillval">
              <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
                {data.press.image && <img src={data.press.image} alt="" style={{ width: 96, height: 96, objectFit: "cover", borderRadius: 12, background: SOFT, flexShrink: 0 }} />}
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 700 }}>Pressar ni åt hela föreningen?</div>
                  <div style={{ ...S.small, marginTop: 2 }}>
                    Då rekommenderar vi {data.press.vendor} {data.press.title}. Den sänker och lyfter plattan själv, så varje tröja får samma tryck och tid. Plattan på 38 × 38 cm rymmer en 25 cm-siffra, och teflonduk ingår.
                  </div>
                  {data.press.url && (
                    <a href={data.press.url} target="_blank" rel="noreferrer" style={{ ...S.link, fontSize: 12.5 }}>
                      Läs mer om pressen
                    </a>
                  )}
                </div>
              </div>
              <button
                type="button"
                aria-pressed={withPress}
                onClick={() => setWithPress((v) => !v)}
                style={{ ...S.secondaryBtn, marginTop: 12, width: "100%", ...(withPress ? { background: INK, color: "#fff", borderColor: INK } : null) }}
              >
                {withPress ? `Tillagd · ${kr(data.press.price)} (ta bort)` : `Lägg till pressen · ${kr(data.press.price)}`}
              </button>
            </Step>
          )}
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
                fontId={style.fontId}
                heightCm={heightCm}
                number={previewNumber}
                onNumber={setPreviewNumber}
                size={shownSize}
                sizes={sizes}
                onSize={setPreviewSize}
                logo={hasLogo ? { src: logoSrc, widthCm: logoWidthCm } : null}
                frontNumber={frontOn ? { heightCm: frontCm, place: frontPlace } : null}
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
              {added ? "Klart! Tar dig till varukorgen…" : progress.step === "upload" ? `Förbereder loggor ${progress.done} av ${progress.total}` : progress.step === "sheet" ? "Lägger loggorna på ett ark…" : "Lägger i varukorgen…"}
            </div>
            <div style={{ ...S.small, marginTop: 8 }}>Siffrorna tas från vårt lager. Loggorna läggs på ett gemensamt ark som trycks och klipps ut åt er.</div>
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
 * it has them. Those are ghost-mannequin shots of a round form: collar to
 * hem is the size chart's length on 98 % of the picture's height, and the
 * body shows as wide as its diameter (chest × 2 / π: 25 cm on 130/140,
 * whose flat width is 39 cm). A print is flat on the fabric and wraps round
 * the form, so each figure is placed by its distance along the fabric and
 * narrowed where the body turns away; drawn flat, a 27 cm number filled the
 * whole back.
 *
 * Without packshots a flat shirt is drawn instead, 220 units across the
 * half chest, and nothing wraps.
 */
const PACK = {
  w: 760,
  h: 1000,
  /** Collar top and the share of the height from collar to hem. */
  collar: 12,
  length: 0.98,
  /** Figures start this share of the length below the collar, chest prints this share. */
  numberAt: 0.19,
  logoAt: 0.2,
  /** Chest logo and small front number: their centres this share of the flat width from the middle. */
  chestSide: 0.2,
};

export type FrontPlace = "left" | "center";

function Preview({
  shirtColor,
  front,
  back,
  ink,
  family,
  fontId,
  heightCm,
  number,
  onNumber,
  size,
  sizes,
  onSize,
  logo,
  frontNumber,
  sponsors,
}: {
  shirtColor: string;
  front: string | null;
  back: string | null;
  ink: string;
  family: string;
  fontId: string;
  heightCm: number;
  number: string;
  onNumber: (v: string) => void;
  size: string;
  sizes: string[];
  onSize: (v: string) => void;
  logo: { src: string | null; widthCm: number } | null;
  frontNumber: { heightCm: number; place: FrontPlace } | null;
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
  const L = chart.length;

  // Along the fabric (cm from the middle) to across the picture: the round
  // form's radius is the chest circumference over 2π.
  const R = (2 * chart.chest) / (2 * Math.PI);
  const angle = (xCm: number) => Math.max(-Math.PI / 2, Math.min(Math.PI / 2, xCm / R));
  const toX = (xCm: number) => cx + (photos ? R * Math.sin(angle(xCm)) : xCm) * u;
  const squeeze = (xCm: number) => (photos ? Math.cos(angle(xCm)) : 1);

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

  /** A number on the fabric, centred on `centreCm`, each figure where it falls on the body. */
  const figures = (text: string, hCm: number, centreCm: number, topY: number) => {
    const widths = [...text].map((ch) => numberWidthCm(fontId, ch, hCm));
    const gap = FIGURE_GAP * hCm;
    const total = widths.reduce((a, b) => a + b, 0) + gap * Math.max(0, widths.length - 1);
    let x = centreCm - total / 2;
    return [...text].map((ch, i) => {
      const mid = x + widths[i]! / 2;
      x += widths[i]! + gap;
      return (
        <text
          key={i}
          transform={`translate(${toX(mid)} ${topY + hCm * u}) scale(${squeeze(mid)} 1)`}
          textAnchor="middle"
          fontSize={(hCm * u) / 0.7}
          fill={ink}
          fontFamily={`"${family}", sans-serif`}
        >
          {ch}
        </text>
      );
    });
  };

  const backSponsor = sponsors.find((s) => s.place === "back" && s.qty > 0);
  const chest = sponsors.find((s) => s.place === "chest" && s.qty > 0);
  const sleeve = sponsors.find((s) => s.place === "sleeve" && s.qty > 0);
  /** A logo of `widthCm` on the fabric, centred on `centreCm`, as wide as it shows on the body. */
  const shownWidth = (widthCm: number, centreCm: number) =>
    photos ? R * (Math.sin(angle(centreCm + widthCm / 2)) - Math.sin(angle(centreCm - widthCm / 2))) * u : widthCm * u;
  const sponsorBox = (sp: Sponsor, centreCm: number, y: number, extra?: string, x?: number) => {
    const w = extra ? sp.widthCm * u : shownWidth(sp.widthCm, centreCm);
    const h = sp.widthCm * u * 0.4;
    const left = (x ?? toX(centreCm)) - w / 2;
    return sp.upload?.url ? (
      <image href={sp.upload.url} x={left} y={y} width={w} height={h} preserveAspectRatio="none" transform={extra} />
    ) : (
      <g transform={extra}>
        <rect x={left} y={y} width={w} height={h} rx={3} fill="none" stroke={ink} strokeDasharray="6 4" strokeWidth={photos ? 3 : 1} opacity={0.8} />
        <text x={left + w / 2} y={y + h / 2 + h * 0.15} textAnchor="middle" fontSize={Math.min(photos ? 30 : 12, h * 0.45)} fill={ink} opacity={0.85} fontFamily="inherit">
          SPONSOR
        </text>
      </g>
    );
  };

  let numberTop = top + PACK.numberAt * L * u;
  const sponsorTop = top + 0.11 * L * u;
  if (backSponsor) numberTop = Math.max(numberTop, sponsorTop + backSponsor.widthCm * u * 0.4 + 2 * u);
  const chestTop = top + PACK.logoAt * L * u;
  const side = PACK.chestSide * chart.chest;
  const shown = number.replace(/\D/g, "").slice(0, 2);
  const frontAt = frontNumber?.place === "center" ? 0 : -side;
  const chestSponsorTop =
    frontNumber?.place === "center" ? chestTop + (frontNumber.heightCm + 3) * u : top + 0.33 * L * u;
  const backWidth = shown ? numberWidthCm(fontId, shown, heightCm) : 0;
  const cm = (n: number) => `${Math.round(n * 10) / 10}`.replace(".", ",");

  return (
    <div style={S.previewCard}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
        <figure style={{ margin: 0, textAlign: "center" }}>
          <svg viewBox={`0 0 ${W} ${viewH}`} style={{ width: "100%", height: "auto", display: "block" }} role="img" aria-label="Tröjans baksida">
            {photos ? <image href={back!} x={0} y={0} width={W} height={PACK.h} preserveAspectRatio="xMidYMin meet" /> : drawn("back")}
            {backSponsor && sponsorBox(backSponsor, 0, sponsorTop)}
            {figures(shown, heightCm, 0, numberTop)}
          </svg>
          <figcaption style={S.small}>Bak</figcaption>
        </figure>
        <figure style={{ margin: 0, textAlign: "center" }}>
          <svg viewBox={`0 0 ${W} ${viewH}`} style={{ width: "100%", height: "auto", display: "block" }} role="img" aria-label="Tröjans framsida">
            {photos ? <image href={front!} x={0} y={0} width={W} height={PACK.h} preserveAspectRatio="xMidYMin meet" /> : drawn("front")}
            {logo &&
              (logo.src ? (
                <image
                  href={logo.src}
                  x={toX(side) - shownWidth(logo.widthCm, side) / 2}
                  y={chestTop}
                  width={shownWidth(logo.widthCm, side)}
                  height={logo.widthCm * u * 1.2}
                  preserveAspectRatio="none"
                />
              ) : (
                <ellipse cx={toX(side)} cy={chestTop + (logo.widthCm * u) / 2} rx={shownWidth(logo.widthCm, side) / 2} ry={(logo.widthCm * u) / 2} fill="none" stroke={ink} strokeDasharray="6 4" strokeWidth={photos ? 3 : 1} />
              ))}
            {frontNumber && shown && figures(shown, frontNumber.heightCm, frontAt, chestTop)}
            {chest && sponsorBox(chest, 0, chestSponsorTop)}
            {sleeve && (photos ? sponsorBox(sleeve, 0, PACK.h * 0.2, `rotate(-62 ${W * 0.1} ${PACK.h * 0.22})`, W * 0.1) : sponsorBox(sleeve, 0, top + 64, `rotate(-52 52 ${top + 70})`, 52))}
          </svg>
          <figcaption style={S.small}>Fram</figcaption>
        </figure>
      </div>
      <div style={{ ...S.small, marginTop: 8, textAlign: "center" }}>
        {shown ? `Nummer ${shown}: ${cm(heightCm)} × ${cm(backWidth)} cm` : "Inget nummer"} · tröja {size}: {chart.chest} cm bred, {chart.length} cm lång (platt)
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
  option: { display: "flex", alignItems: "flex-start", gap: 10, marginTop: 12, padding: "10px 12px", border: `1px solid ${LINE}`, borderRadius: 12, cursor: "pointer", fontSize: 14 },
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
  secondaryBtn: { borderWidth: 1, borderStyle: "solid", borderColor: "rgba(0,0,0,0.16)", background: "#fff", borderRadius: 10, padding: "10px 14px", cursor: "pointer", font: "inherit", fontSize: 13.5, fontWeight: 600, color: INK, height: 44 },
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
