import { useEffect, useMemo, useRef, useState } from "react";
import { fontById, fontFamily, loadFont } from "../config/fonts";
import { INITIALS_CM, NAME_SIZES_CM, NAME_STYLES, NUMBER_SIZES_CM, NUMBER_STYLES, contrastOf, styleById, type Look, type Setup } from "./catalog";
import { cleanInitials, initialsOf, newRow, parseRoster, readCsvFile, rowInitials, type Row } from "./roster";
import { readXlsxFile } from "./xlsx";
import { TIERS, kr, nextTier, priceKey, tierFor, type PieceKind, type PriceList } from "./pricing";
import { orderGraphics, planGraphics, totalsOf, type CartLine, type Graphic, type LogoPiece, type OrderProgress } from "./order";
import { PackshotPreview, textWidthCm, type PreviewLogo } from "./ShirtPreview";
import { StylePicker } from "./NamesNumbers";
import { DIGIT_HEIGHTS_CM, DIGIT_INKS, LOGO_WIDTHS_CM, SIZE_CHART, countDigits, digitStockKey, logoKey, parseNumbers, type TeamData } from "../team/data";

/**
 * "Namn och Siffror" on its product page, built like the team page:
 *
 * 1. What to print (names, numbers or both, initials if wanted) and in
 *    white or black.
 * 2. The numbers, in the shop's own figures Arena and Skugglinje. 20 and
 *    25 cm come from stock, a figure at a time: the number of players
 *    (1-15 needs eight ones) or the team's own numbers fill in the count
 *    of each figure 0-9. 5-10 cm numbers are printed whole.
 * 3. The names: style and size.
 * 4. The list, typed, pasted, or read from the Excel template or a CSV.
 *    Any row can be shown on the shirt.
 * 5. Sponsor logos, 6. the shirt and 7. the press, as on the team page.
 *
 * Names, printed numbers, initials and sponsors go on one gang sheet the
 * print shop prints and cuts; stock digits, shirts and the press are plain
 * cart lines. The shirt beside it shows the back and front to scale on the
 * shirt's own packshots.
 */

const ACCENT = "#dc2f3c";
const INK = "#18181b";
const MUTED = "#6b6b70";
const LINE = "rgba(0,0,0,0.1)";
const SOFT = "#f5f5f4";
const VAT = 0.25;

/** The shop's own figures, the only ones stocked. */
const FIGURE_STYLES = NUMBER_STYLES.filter((s) => s.id === "arena" || s.id === "skugglinje");
/** Sizes printed whole, for the chest, shorts or sleeve. */
const PRINTED_NUMBER_CM = NUMBER_SIZES_CM.filter((cm) => !DIGIT_HEIGHTS_CM.includes(cm));

/** Shopify colour names of the shirts we sell, for swatches and the drawn shirt. */
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
  { id: "back", label: "Rygg, överst" },
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

export interface NamesPageData {
  /** This product's variants: "Namn 7 cm", "Nummer 10 cm", "Initialer 3 cm". */
  prices: PriceList;
  /** The shirt, stock digits, logo prices and press, as the team page gets them. */
  team: TeamData;
  /** The Excel template in Shopify Files. */
  templateUrl: string | null;
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

export function NamesPage({ data }: { data: NamesPageData }) {
  const { prices, team, templateUrl } = data;
  const shirt = team.shirt;
  const rootRef = useRef<HTMLDivElement>(null);
  const wide = useWide(rootRef);

  const [setup, setSetup] = useState<Setup>("both");
  const [withInitials, setWithInitials] = useState(false);
  const [ink, setInk] = useState("#ffffff");
  const [numberStyle, setNumberStyle] = useState(FIGURE_STYLES[0]!.id);
  const [numberCm, setNumberCm] = useState(20);
  const [nameStyle, setNameStyle] = useState(NAME_STYLES[0]!.id);
  const [nameCm, setNameCm] = useState(7);
  const [uppercase, setUppercase] = useState(true);

  const [rows, setRows] = useState<Row[]>(() => [newRow(), newRow(), newRow()]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<"table" | "paste" | "file">("table");
  const [paste, setPaste] = useState("");

  const [players, setPlayers] = useState("");
  const [ownNumbers, setOwnNumbers] = useState("");
  /** The numbers when there is no list: from the players or typed. */
  const [numberList, setNumberList] = useState<string[]>([]);
  const [previewNumber, setPreviewNumber] = useState("10");
  /** Figures added or taken away by hand, on top of what the numbers need. */
  const [extra, setExtra] = useState<number[]>(() => Array(10).fill(0));
  // One spare of every figure, for players who join during the season.
  const [spare, setSpare] = useState(false);

  const colors = useMemo(() => [...new Set(shirt?.variants.map((v) => v.color) ?? [])], [shirt]);
  const sizes = useMemo(() => [...new Set(shirt?.variants.map((v) => v.size) ?? [])], [shirt]);
  const [shirtColor, setShirtColor] = useState(colors[0] ?? "Royalblå");
  const [shirtQty, setShirtQty] = useState<Record<string, number>>({});
  const [previewSize, setPreviewSize] = useState<string | null>(null);

  const [sponsors, setSponsors] = useState<Sponsor[]>([]);
  const [withPress, setWithPress] = useState(false);
  const [graphics, setGraphics] = useState<Graphic[]>([]);
  const [progress, setProgress] = useState<OrderProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState(false);
  const [, setFontsReady] = useState(0);

  const showNames = setup !== "numbers";
  const showNumbers = setup !== "names";
  const showTable = showNames || withInitials;
  /** The numbers come from the list's number column. */
  const listNumbers = showTable && showNumbers;
  const stock = showNumbers && DIGIT_HEIGHTS_CM.includes(numberCm);
  const figure = FIGURE_STYLES.find((s) => s.id === numberStyle) ?? FIGURE_STYLES[0]!;
  const numberFamily = fontFamily(fontById(figure.fontId));
  const nameFamily = fontFamily(fontById(styleById(nameStyle).fontId));

  useEffect(() => {
    let alive = true;
    const fonts = [...FIGURE_STYLES.map((s) => s.fontId), styleById(nameStyle).fontId];
    void Promise.all(fonts.map((id) => loadFont(fontById(id)))).then(() => alive && setFontsReady((n) => n + 1));
    return () => {
      alive = false;
    };
  }, [nameStyle]);

  const look: Look = { setup, nameStyle, numberStyle, color: ink, outline: "none", nameCm, numberCm, uppercase, initials: withInitials };
  const filled = rows.filter((r) => (showNames && r.name.trim()) || (showNumbers && r.number.trim()) || (withInitials && rowInitials(r)));
  const teamNumbers = listNumbers
    ? filled.flatMap((r) => (r.number.trim() ? (Array(Math.max(1, r.qty)).fill(r.number.trim()) as string[]) : []))
    : showNumbers
      ? numberList
      : [];
  const players0 = filled.length || numberList.length;
  const derived = countDigits(teamNumbers);
  const digits = derived.map((n, d) => Math.max(0, n + extra[d]!));
  const orderDigits = stock ? digits.map((n) => n + (spare ? 1 : 0)) : (Array(10).fill(0) as number[]);
  const digitCount = orderDigits.reduce((a, b) => a + b, 0);

  // What is printed: names, numbers below 20 cm, initials.
  const printRows: Row[] = showTable ? filled : numberList.map((n, i) => newRow({ id: `n${i}`, number: n }));
  const parts = { names: showNames, numbers: showNumbers && !stock, initials: withInitials };
  const planKey = JSON.stringify([printRows.map((r) => [r.name, r.number, r.qty, r.initials]), look, parts]);
  useEffect(() => {
    let alive = true;
    const t = window.setTimeout(() => {
      void planGraphics(printRows, look, prices, parts).then((g) => alive && setGraphics(g));
    }, 120);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planKey, prices]);

  // Prices
  const inkLabel = DIGIT_INKS.find((c) => c.value === ink)?.label ?? "Vit";
  const stockDigit = (d: number, h = numberCm) => team.digits.get(digitStockKey(figure.label, h, inkLabel, d)) ?? null;
  const pieceKey = (kind: PieceKind) => (kind === "name" ? priceKey("name", nameCm) : kind === "number" ? priceKey("number", numberCm) : priceKey("initials", INITIALS_CM));
  const piecePrice = (kind: PieceKind, cm?: number) => prices.get(cm === undefined ? pieceKey(kind) : priceKey(kind, cm))?.price ?? null;
  const logoPrice = (widthCm: number) => team.prices.get(logoKey(widthCm)) ?? null;
  const variantFor = (size: string) => shirt?.variants.find((v) => v.color === shirtColor && v.size === size) ?? null;

  const totals = totalsOf(graphics);
  const tier = tierFor(totals.pieces);
  const next = nextTier(totals.pieces);
  const discount = tier ? (totals.subtotal * tier.pct) / 100 : 0;

  const lines: { label: string; detail: string; qty: number; unit: number }[] = [];
  const LABEL: Record<PieceKind, string> = { name: `Namn ${nameCm} cm`, number: `Nummer ${numberCm} cm`, initials: `Initialer ${INITIALS_CM} cm` };
  for (const kind of ["name", "number", "initials"] as PieceKind[]) {
    const priced = graphics.filter((g) => g.kind === kind && g.price && !g.tooWide);
    const count = priced.reduce((n, g) => n + g.count, 0);
    if (count) lines.push({ label: LABEL[kind], detail: "tryckta och utklippta", qty: count, unit: priced[0]!.price!.price });
  }
  const digitPrice = stockDigit(0);
  if (digitCount && digitPrice) lines.push({ label: `Siffror ${numberCm} cm, ${figure.label.toLowerCase()}`, detail: `${inkLabel.toLowerCase()}, från lager`, qty: digitCount, unit: digitPrice.price });
  sponsors.forEach((sp, i) => {
    const p = logoPrice(sp.widthCm);
    if (p && sp.qty && sp.upload) lines.push({ label: `Sponsorlogga ${i + 1}`, detail: `${sp.widthCm} cm, ${PLACES.find((x) => x.id === sp.place)!.label.toLowerCase()}`, qty: sp.qty, unit: p.price });
  });
  for (const s of sizes) {
    const v = variantFor(s);
    if (v && shirtQty[s]) lines.push({ label: `${shirt!.title}, ${shirtColor}`, detail: s, qty: shirtQty[s]!, unit: v.price });
  }
  if (withPress && team.press) lines.push({ label: `${team.press.vendor} ${team.press.title}`.trim(), detail: "Värmepress", qty: 1, unit: team.press.price });
  const subtotal = lines.reduce((s, l) => s + l.qty * l.unit, 0) - discount;

  const missingDigits = orderDigits.some((n, d) => n > 0 && !stockDigit(d));
  const blocked = totals.blocked.map((g) =>
    g.tooWide ? `"${g.text}" blir bredare än filmen i ${g.heightCm} cm` : `${LABEL[g.kind]} saknar pris`,
  );
  const sponsorsWithoutFile = sponsors.some((s) => s.qty > 0 && !s.upload);
  const canOrder = subtotal > 0 && !missingDigits && blocked.length === 0 && !sponsorsWithoutFile && !progress;

  // Preview
  const selected = showTable ? (filled.find((r) => r.id === selectedId) ?? filled[0] ?? null) : null;
  const upper = (s: string) => (uppercase ? s.toLocaleUpperCase("sv-SE") : s);
  const shownName = !showNames ? null : selected ? upper(selected.name.trim()) || null : "NAMN";
  const shownNumber = !showNumbers ? null : listNumbers ? (selected ? selected.number.trim() || null : "10") : previewNumber.replace(/\D/g, "").slice(0, 3) || null;
  const shownInitials = !withInitials ? null : selected ? rowInitials(selected) || null : "AA";
  const smallest = sizes.find((s) => shirtQty[s]) ?? sizes[1] ?? sizes[0] ?? "130/140";
  const shownSize = previewSize && sizes.includes(previewSize) ? previewSize : smallest;
  const chart = SIZE_CHART[shownSize] ?? SIZE_CHART["130/140"]!;
  const packshot = variantFor(shownSize) ?? shirt?.variants.find((v) => v.color === shirtColor) ?? null;
  const twoWide = showNumbers && numberCm >= 20 ? textWidthCm(numberFamily, "88", numberCm) : 0;
  const tooWide = twoWide > chart.chest * 0.75;
  // The widest name against the back of the size shown, margins left.
  const widestName = showNames
    ? filled.reduce<{ text: string; cm: number } | null>((w, r) => {
        const text = upper(r.name.trim());
        if (!text) return w;
        const cm = textWidthCm(nameFamily, text, nameCm, "HANDE");
        return !w || cm > w.cm ? { text, cm } : w;
      }, null)
    : null;
  const nameTooWide = widestName && widestName.cm > chart.chest * 0.9 ? widestName : null;
  const previewSponsors: PreviewLogo[] = sponsors.filter((s) => s.qty > 0).map((s) => ({ src: s.upload?.url ?? null, widthCm: s.widthCm, place: s.place }));

  // White shirts get black prints; picking a dark shirt again brings white back.
  const pickShirtColor = (c: string) => {
    setShirtColor(c);
    const hex = shirtHex(c);
    if (ink === "#ffffff" && contrastOf(hex) === "#111111") setInk("#111111");
    if (ink === "#111111" && contrastOf(hex) === "#ffffff") setInk("#ffffff");
  };

  const setRow = (id: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  /** Numbers into the list's number column, in order; rows are added as needed. */
  const numbersIntoList = (numbers: string[]) =>
    setRows((rs) => {
      const out = [...rs];
      numbers.forEach((n, i) => {
        out[i] = out[i] ? { ...out[i]!, number: n } : newRow({ number: n });
      });
      return out;
    });

  /**
   * Switching between a list and none keeps the numbers: typed without a
   * list they go into its number column, and back out when it goes.
   */
  const pickParts = (nextSetup: Setup, nextInitials: boolean) => {
    const nextTable = nextSetup !== "numbers" || nextInitials;
    if (showTable && !nextTable) {
      const numbers = rows.map((r) => r.number.trim()).filter(Boolean);
      if (numbers.length) setNumberList(numbers);
    } else if (!showTable && nextTable && nextSetup !== "names" && numberList.length && !rows.some((r) => r.number.trim())) {
      numbersIntoList(numberList);
    }
    setSetup(nextSetup);
    setWithInitials(nextInitials);
  };

  const applyNumbers = (numbers: string[]) => {
    setError(null);
    setExtra(Array(10).fill(0));
    if (listNumbers) numbersIntoList(numbers);
    else setNumberList(numbers);
    setPreviewNumber(numbers.find((x) => x.length === 2) ?? numbers[0] ?? "10");
  };

  // The digits follow the number of players as it is typed: 1-15 needs
  // eight ones and one of every other figure.
  const fromPlayers = (value: string) => {
    setPlayers(value);
    const n = Math.max(0, Math.min(99, parseInt(value, 10) || 0));
    if (!n) return;
    setOwnNumbers("");
    applyNumbers(Array.from({ length: n }, (_, i) => String(i + 1)));
  };

  // A team's own numbers ("1, 4, 7, 23") are used when asked, not while typing.
  const fromOwnNumbers = () => {
    const numbers = parseNumbers(ownNumbers);
    if (numbers.length === 0) {
      setError("Skriv era nummer, till exempel 1, 4, 7, 23.");
      return;
    }
    setPlayers("");
    applyNumbers(numbers);
  };

  const addParsed = (parsed: Row[]) => {
    if (parsed.length === 0) {
      setError('Hittade inga spelare. En rad per spelare, t.ex. "Andersson, 10", eller använd Excelmallen.');
      return;
    }
    setError(null);
    setRows((rs) => [...rs.filter((r) => r.name.trim() || r.number.trim() || (r.initials ?? "").trim()), ...parsed]);
    setSelectedId(parsed[0]!.id);
    setTab("table");
  };

  const readFile = async (file: File) => {
    try {
      if (/\.xls$/i.test(file.name)) throw new Error("xls");
      const text = /\.xlsx$/i.test(file.name) ? await readXlsxFile(file) : await readCsvFile(file);
      addParsed(parseRoster(text));
    } catch {
      setError("Kunde inte läsa filen. Spara den som Excel (.xlsx) eller CSV och försök igen.");
    }
  };

  const order = async () => {
    if (!canOrder) return;
    setError(null);
    setProgress({ step: "draw", done: 0, total: 1 });
    try {
      // The digits come from stock: a cart line per figure, so Shopify
      // counts the stock down.
      const plain: CartLine[] = [];
      orderDigits.forEach((count, d) => {
        const v = stockDigit(d);
        if (count && v) plain.push({ variantId: v.variantId, quantity: count });
      });
      for (const s of sizes) {
        const v = variantFor(s);
        if (v && shirtQty[s]) plain.push({ variantId: v.id, quantity: shirtQty[s]! });
      }
      if (withPress && team.press) plain.push({ variantId: team.press.variantId, quantity: 1 });
      const logos: LogoPiece[] = [];
      sponsors.forEach((sp, i) => {
        const p = logoPrice(sp.widthCm);
        if (!p || !sp.qty || !sp.upload) return;
        const file = sp.upload.file;
        logos.push({
          key: `logo|sponsor|${sp.id}`,
          count: sp.qty,
          price: p,
          widthCm: sp.widthCm,
          file: async () => file,
          properties: { Logga: `Sponsor ${i + 1} (${file.name})`, Bredd: `${sp.widthCm} cm`, Placering: PLACES.find((x) => x.id === sp.place)!.label },
        });
      });
      await orderGraphics(graphics, look, printRows, setProgress, { logos, lines: plain });
      setAdded(true);
      const root = (window as any).Shopify?.routes?.root || "/";
      window.setTimeout(() => (window.location.href = `${root}cart`), 1200);
    } catch (err) {
      setError((err as Error).message);
      setProgress(null);
    }
  };

  let stepNo = 0;
  const n = () => ++stepNo;

  const preview = (
    <div style={S.previewCard}>
      <PackshotPreview
        front={packshot?.front ?? null}
        back={packshot?.back ?? null}
        shirtColor={shirtHex(shirtColor)}
        chart={chart}
        ink={ink}
        name={shownName}
        number={shownNumber}
        initials={shownInitials}
        nameFamily={nameFamily}
        numberFamily={numberFamily}
        nameCm={nameCm}
        numberCm={showNumbers ? numberCm : 20}
        initialsCm={INITIALS_CM}
        sponsors={previewSponsors}
      />
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
        {showTable && filled.length > 0 ? (
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            Visa rad
            <select value={selected?.id ?? ""} onChange={(e) => setSelectedId(e.target.value)} style={{ ...S.input, padding: "6px 8px", fontSize: 14, flex: 1 }} aria-label="Visa rad">
              {filled.map((r, i) => (
                <option key={r.id} value={r.id}>
                  {i + 1}. {[showNumbers ? r.number : "", showNames ? upper(r.name) : "", withInitials && rowInitials(r) ? `(${rowInitials(r)})` : ""].filter(Boolean).join(" ") || "tom rad"}
                </option>
              ))}
            </select>
          </label>
        ) : !showTable && showNumbers ? (
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            Visa nummer
            <input type="text" inputMode="numeric" maxLength={2} value={previewNumber} onChange={(e) => setPreviewNumber(e.target.value)} style={{ ...S.input, width: 64, padding: "6px 8px" }} />
          </label>
        ) : null}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
          {colors.length > 0 && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }} role="group" aria-label="Tröjans färg">
              {colors.map((c) => (
                <button
                  key={c}
                  type="button"
                  title={c}
                  aria-label={`Tröja: ${c}`}
                  aria-pressed={c === shirtColor}
                  onClick={() => pickShirtColor(c)}
                  style={{ ...S.swatchSmall, background: shirtHex(c), boxShadow: c === shirtColor ? `0 0 0 2px #fff, 0 0 0 4px ${ACCENT}` : "none" }}
                />
              ))}
            </div>
          )}
          {sizes.length > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }} role="group" aria-label="Visa på storlek">
              {sizes.map((s) => (
                <button key={s} type="button" aria-pressed={s === shownSize} onClick={() => setPreviewSize(s)} style={{ ...S.sizeChip, ...(s === shownSize ? S.sizeChipOn : null) }}>
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  const summary = (
    <div style={S.summary}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 14 }}>
        {lines.length === 0 && <div style={S.small}>Fyll i laget så räknas priset fram här.</div>}
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
        {discount > 0 && (
          <div style={{ ...S.sumRow, color: "#2e7d32" }}>
            <span>Mängdrabatt {tier!.pct} % på trycken</span>
            <span style={{ whiteSpace: "nowrap" }}>−{kr(Math.round(discount * 100) / 100)}</span>
          </div>
        )}
      </div>
      {totals.pieces > 0 && next && (
        <div style={{ ...S.small, marginTop: 8 }}>
          Lägg till {next.min - totals.pieces} tryck till för {next.pct} % mängdrabatt på trycken.
        </div>
      )}
      <div style={{ borderTop: `1px solid ${LINE}`, marginTop: 12, paddingTop: 12, display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={S.sumRow}>
          <span>Summa exkl. moms</span>
          <strong style={{ fontVariantNumeric: "tabular-nums" }}>{kr(Math.round(Math.max(0, subtotal) * 100) / 100)}</strong>
        </div>
        <div style={{ ...S.sumRow, ...S.small }}>
          <span>Inkl. moms</span>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>{kr(Math.round(Math.max(0, subtotal) * (1 + VAT) * 100) / 100)}</span>
        </div>
        {discount > 0 && <div style={S.small}>Rabatten dras i kassan.</div>}
      </div>
      {missingDigits && <div style={S.error}>Siffrorna saknar pris i den här storleken. Välj en annan.</div>}
      {blocked.length > 0 && <div style={S.error}>{blocked.slice(0, 3).join(". ")}. Välj en mindre storlek eller korta namnet.</div>}
      {sponsorsWithoutFile && <div style={S.error}>Ladda upp sponsorloggan, eller ta bort raden.</div>}
      <button type="button" onClick={() => void order()} disabled={!canOrder} style={{ ...S.primary, marginTop: 14, ...(canOrder ? null : S.primaryOff) }}>
        {progress ? "Förbereder…" : "Lägg i varukorgen"}
      </button>
      <div style={{ ...S.small, marginTop: 8, textAlign: "center" }}>Ni pressar själva på 15 sekunder, med värmepress eller strykjärn.</div>
    </div>
  );

  const figureSample = (fontId: string, text: string) => (
    <span style={{ ...S.styleSample, background: shirtHex(shirtColor), color: ink, fontFamily: `"${fontFamily(fontById(fontId))}", sans-serif` }}>{text}</span>
  );

  return (
    <div ref={rootRef} style={S.root}>
      <div style={{ display: "grid", gridTemplateColumns: wide ? "minmax(0, 1.15fr) minmax(0, 0.85fr)" : "minmax(0, 1fr)", gap: wide ? 36 : 18, alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
          {/* On a phone the shirt is a reminder above the steps, not the page. */}
          {!wide && <div style={{ maxWidth: 360, width: "100%", margin: "0 auto" }}>{preview}</div>}

          <Step n={n()} title="Vad vill ni trycka?">
            <div style={S.cards3}>
              {(
                [
                  { id: "both", label: "Namn + nummer", sample: "NAMN 10" },
                  { id: "numbers", label: "Nummer", sample: "10" },
                  { id: "names", label: "Namn", sample: "NAMN" },
                ] as { id: Setup; label: string; sample: string }[]
              ).map((o) => (
                <button key={o.id} type="button" aria-pressed={setup === o.id} onClick={() => pickParts(o.id, withInitials)} style={{ ...S.card, ...(setup === o.id ? S.cardOn : null) }}>
                  <span style={S.cardSample}>{o.sample}</span>
                  <span style={S.cardLabel}>{o.label}</span>
                </button>
              ))}
            </div>
            <label style={S.option}>
              <input type="checkbox" checked={withInitials} onChange={(e) => pickParts(setup, e.target.checked)} style={{ accentColor: ACCENT, width: 18, height: 18, flexShrink: 0 }} />
              <span>
                <strong>Initialer under klubbmärket</strong>
                <span style={{ ...S.small, display: "block" }}>
                  {INITIALS_CM} cm höga på bröstet, en per spelare{piecePrice("initials") !== null ? ` · ${kr(piecePrice("initials")!)}/st` : ""}. Skriv dem i listan, eller skriv för- och efternamn så tar vi första bokstäverna.
                </span>
              </span>
            </label>
            <div style={{ ...S.row, marginTop: 12 }}>
              <span style={S.fieldLabel}>Färg</span>
              <div style={S.swatches}>
                {DIGIT_INKS.map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    title={c.label}
                    aria-label={`Tryck: ${c.label}`}
                    aria-pressed={c.value === ink}
                    onClick={() => setInk(c.value)}
                    style={{ ...S.swatch, background: c.value, boxShadow: c.value === ink ? `0 0 0 2px #fff, 0 0 0 4px ${ACCENT}` : "none" }}
                  />
                ))}
              </div>
              <span style={S.small}>{inkLabel}: {ink === "#ffffff" ? "för mörka tröjor" : "för ljusa tröjor"}</span>
            </div>
          </Step>

          {showNumbers && (
            <Step n={n()} title="Siffror" aside={stock ? `${digitCount} st${digitPrice ? ` · ${kr(digitPrice.price)}/st` : ""}` : `${teamNumbers.length} nummer`}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
                {FIGURE_STYLES.map((s) => (
                  <button key={s.id} type="button" aria-pressed={s.id === numberStyle} onClick={() => setNumberStyle(s.id)} style={{ ...S.card, padding: 10, ...(s.id === numberStyle ? S.cardOn : null) }}>
                    {figureSample(s.fontId, "13")}
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{s.label}</span>
                  </button>
                ))}
              </div>
              <div style={{ ...S.row, marginTop: 12, alignItems: "flex-start" }}>
                <span style={{ ...S.fieldLabel, paddingTop: 8 }}>Höjd</span>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                    {DIGIT_HEIGHTS_CM.map((h) => {
                      const p = stockDigit(0, h);
                      return (
                        <button key={h} type="button" aria-pressed={h === numberCm} onClick={() => setNumberCm(h)} style={{ ...S.chip, ...(h === numberCm ? S.chipOn : null) }}>
                          <span style={{ fontWeight: 600 }}>{h} cm</span>
                          {p && <span style={{ fontSize: 11.5, opacity: 0.75 }}>{kr(p.price)}/siffra</span>}
                        </button>
                      );
                    })}
                    <span style={S.small}>Rygg, från vårt lager</span>
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                    {PRINTED_NUMBER_CM.map((h) => {
                      const p = piecePrice("number", h);
                      return (
                        <button key={h} type="button" aria-pressed={h === numberCm} onClick={() => setNumberCm(h)} style={{ ...S.chip, ...(h === numberCm ? S.chipOn : null) }}>
                          <span style={{ fontWeight: 600 }}>{h} cm</span>
                          {p !== null && <span style={{ fontSize: 11.5, opacity: 0.75 }}>{kr(p)}/nr</span>}
                        </button>
                      );
                    })}
                    <span style={S.small}>Bröst, shorts, ärm, tryckta</span>
                  </div>
                </div>
              </div>
              {tooWide && (
                <div style={{ ...S.note, marginTop: 12 }}>
                  Två siffror i {numberCm} cm blir ca {Math.round(twoWide)} cm breda, nästan hela ryggen på {shownSize}. Vi rekommenderar 20 cm.
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
              <div style={{ ...S.small, marginTop: 6 }}>
                {listNumbers
                  ? "Numren hamnar i listan nedan, i ordning, och siffrorna räknas från listan. Skriv sedan namnen."
                  : stock
                    ? "Siffrorna räknas ut direkt när ni skriver antal spelare: 1-15 behöver 21 siffror, åtta ettor och en av varje annan. Har ni egna nummer, skriv dem och klicka Använd numren."
                    : "Varje nummer trycks helt och klipps ut. Skriv antal spelare eller era egna nummer."}
              </div>
              {stock ? (
                <>
                  <div style={{ display: "grid", gridTemplateColumns: `repeat(${wide ? 5 : 3}, minmax(0, 1fr))`, gap: 8, marginTop: 12 }}>
                    {digits.map((count, d) => (
                      <div key={d} style={S.digit}>
                        <span style={{ ...S.digitTile, background: shirtHex(shirtColor), color: ink, fontFamily: `"${numberFamily}", sans-serif` }}>{d}</span>
                        <Stepper
                          value={count}
                          onChange={(v) => setExtra((xs) => xs.map((x, i) => (i === d ? v - derived[d]! : x)))}
                          label={`Antal av siffran ${d}`}
                        />
                      </div>
                    ))}
                  </div>
                  {listNumbers && extra.some(Boolean) && (
                    <button type="button" onClick={() => setExtra(Array(10).fill(0))} style={{ ...S.link, fontSize: 12.5, marginTop: 8 }}>
                      Räkna om från listan
                    </button>
                  )}
                  <label style={S.option}>
                    <input type="checkbox" checked={spare} onChange={(e) => setSpare(e.target.checked)} style={{ accentColor: ACCENT, width: 18, height: 18, flexShrink: 0 }} />
                    <span>
                      <strong>Reservsiffror, en av varje 0-9</strong>
                      <span style={{ ...S.small, display: "block" }}>
                        10 extra siffror{digitPrice ? ` för ${kr(10 * digitPrice.price)}` : ""}, för spelare som kommer till under säsongen eller en siffra som går sönder.
                      </span>
                    </span>
                  </label>
                </>
              ) : (
                !listNumbers &&
                numberList.length > 0 && (
                  <div style={{ ...S.small, marginTop: 10 }}>
                    Trycks: {numberList.slice(0, 40).join(", ")}
                    {numberList.length > 40 ? " …" : ""}
                  </div>
                )
              )}
            </Step>
          )}

          {showNames && (
            <Step n={n()} title="Namn" aside={piecePrice("name") !== null ? `${kr(piecePrice("name")!)}/st` : undefined}>
              <StylePicker label="Stil" styles={NAME_STYLES} value={nameStyle} sample="ABC" onPick={(s) => setNameStyle(s.id)} />
              <div style={S.row}>
                <span style={S.fieldLabel}>Höjd</span>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {NAME_SIZES_CM.map((h) => {
                    const p = piecePrice("name", h);
                    return (
                      <button key={h} type="button" aria-pressed={h === nameCm} onClick={() => setNameCm(h)} style={{ ...S.chip, ...(h === nameCm ? S.chipOn : null) }}>
                        <span style={{ fontWeight: 600 }}>{h} cm</span>
                        {p !== null && <span style={{ fontSize: 11.5, opacity: 0.75 }}>{kr(p)}/st</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
              <label style={{ ...S.row, marginTop: 12, cursor: "pointer", gap: 8 }}>
                <input type="checkbox" checked={uppercase} onChange={(e) => setUppercase(e.target.checked)} style={{ accentColor: ACCENT, width: 16, height: 16 }} />
                <span style={{ fontSize: 14 }}>Namn i versaler</span>
              </label>
              {nameTooWide && (
                <div style={{ ...S.note, marginTop: 12 }}>
                  {nameTooWide.text} blir ca {Math.round(nameTooWide.cm)} cm brett i {nameCm} cm, bredare än ryggen på {shownSize}.{" "}
                  {nameCm > NAME_SIZES_CM[0]! ? `Välj ${NAME_SIZES_CM[0]} cm eller ett kortare namn.` : "Korta namnet, eller visa en större storlek."}
                </div>
              )}
            </Step>
          )}

          {showTable && (
            <Step n={n()} title="Spelarlistan" aside={`${filled.length} spelare`}>
              <div style={S.tabs} role="tablist">
                {(
                  [
                    { id: "table", label: "Tabell" },
                    { id: "paste", label: "Klistra in" },
                    { id: "file", label: "Excel eller CSV" },
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
                  showName={showNames}
                  showNumber={showNumbers}
                  showInitials={withInitials}
                  compact={!wide}
                  selectedId={selected?.id ?? null}
                  onSelect={setSelectedId}
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
                  <div style={S.small}>En spelare per rad: namn, nummer och antal (antal är valfritt). Kopiera raderna direkt från Excel eller Google Sheets, gärna med rubrikraden.</div>
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

              {tab === "file" && <FileDrop onFile={(f) => void readFile(f)} />}

              {templateUrl && (
                <div style={{ ...S.small, marginTop: 10 }}>
                  Vill ni inte skriva här?{" "}
                  <a href={templateUrl} download style={{ ...S.link, fontSize: 12.5 }}>
                    Ladda ner Excelmallen
                  </a>
                  , fyll i namn, nummer och initialer och ladda upp den under Excel eller CSV.
                </div>
              )}
            </Step>
          )}

          <Step n={n()} title="Sponsortryck" aside="Tillval">
            <div style={S.small}>
              Sponsorns logga på ryggen, bröstet eller ärmen, tryckt och utklippt med namnen. Ladda upp loggan, välj plats och bredd. PNG med genomskinlig bakgrund eller PDF ger bäst resultat.
            </div>
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
                        {w} cm bred{logoPrice(w) ? ` · ${kr(logoPrice(w)!.price)}` : ""}
                      </option>
                    ))}
                  </select>
                  <div style={wide ? undefined : { gridColumn: "2 / 3" }}>
                    <Stepper value={sp.qty} onChange={(v) => setSponsors((ss) => ss.map((x) => (x.id === sp.id ? { ...x, qty: v } : x)))} label={`Antal sponsor ${i + 1}`} />
                  </div>
                  <button
                    type="button"
                    aria-label={`Ta bort sponsor ${i + 1}`}
                    onClick={() => setSponsors((ss) => ss.filter((x) => x.id !== sp.id))}
                    style={{ ...S.remove, ...(wide ? null : { gridRow: "1 / 2", gridColumn: "3 / 4" }) }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setSponsors((ss) => [...ss, { id: Math.random().toString(36).slice(2), upload: null, place: "back", widthCm: 15, qty: players0 || 1 }])}
              style={{ ...S.secondaryBtn, marginTop: 10 }}
            >
              + Lägg till sponsorlogga
            </button>
          </Step>

          {shirt && (
            <Step n={n()} title="Tröjor" aside="Tillval">
              <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
                {variantFor(sizes[0] ?? "")?.image && (
                  <img src={variantFor(sizes[0]!)!.image!} alt="" style={{ width: 76, height: 95, objectFit: "cover", borderRadius: 10, background: SOFT, flexShrink: 0 }} />
                )}
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 700 }}>
                    {shirt.vendor ? `${shirt.vendor} ` : ""}
                    {shirt.title}
                  </div>
                  <div style={S.small}>
                    Tröjan i förhandsvisningen, funktions-t-shirt i polyester för barn · {kr(variantFor(sizes[0] ?? "")?.price ?? 0)} exkl. moms
                  </div>
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
                      aria-pressed={c === shirtColor}
                      onClick={() => pickShirtColor(c)}
                      style={{ ...S.swatch, background: shirtHex(c), boxShadow: c === shirtColor ? `0 0 0 2px #fff, 0 0 0 4px ${ACCENT}` : "none" }}
                    />
                  ))}
                </div>
                <span style={S.small}>{shirtColor}</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(3, sizes.length)}, minmax(0, 1fr))`, gap: 8, marginTop: 12 }}>
                {sizes.map((s) => (
                  <label key={s} style={S.qtyBox}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{s}</span>
                    <Stepper value={shirtQty[s] || 0} onChange={(v) => setShirtQty((q) => ({ ...q, [s]: v }))} label={`Tröjor i ${s}`} />
                  </label>
                ))}
              </div>
            </Step>
          )}

          {team.press && (
            <Step n={n()} title="Press" aside="Tillval">
              <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
                {team.press.image && <img src={team.press.image} alt="" style={{ width: 96, height: 96, objectFit: "cover", borderRadius: 12, background: SOFT, flexShrink: 0 }} />}
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 700 }}>Pressar ni åt hela föreningen?</div>
                  <div style={{ ...S.small, marginTop: 2 }}>
                    Då rekommenderar vi {team.press.vendor} {team.press.title}. Den sänker och lyfter plattan själv, så varje tröja får samma tryck och tid. Plattan på 38 × 38 cm rymmer en 25 cm-siffra, och teflonduk ingår.
                  </div>
                  {team.press.url && (
                    <a href={team.press.url} target="_blank" rel="noreferrer" style={{ ...S.link, fontSize: 12.5 }}>
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
                {withPress ? `Tillagd · ${kr(team.press.price)} (ta bort)` : `Lägg till pressen · ${kr(team.press.price)}`}
              </button>
            </Step>
          )}

          {!wide && summary}
          {error && <div style={S.error}>{error}</div>}
        </div>

        {wide && (
          <div style={{ alignSelf: "stretch" }}>
            <div style={{ position: "sticky", top: 96, display: "flex", flexDirection: "column", gap: 14 }}>
              {preview}
              {summary}
              {totals.pieces > 0 && (
                <div style={S.tiers} aria-label="Mängdrabatt på trycken">
                  {TIERS.map((t) => (
                    <div key={t.min} style={{ ...S.tier, ...(tier && tier.pct >= t.pct ? S.tierOn : null) }}>
                      <span style={{ fontWeight: 700 }}>−{t.pct} %</span>
                      <span style={{ fontSize: 11 }}>{t.min}+ tryck</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {progress && (
        <div style={S.backdrop} role="dialog" aria-modal="true" aria-label="Lägger i varukorgen">
          <div style={S.modal}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, fontWeight: 700 }}>
              {!added && <span style={S.spinner} />}
              {added
                ? "Klart! Tar dig till varukorgen…"
                : progress.step === "upload"
                  ? `Förbereder trycken ${progress.done} av ${progress.total}`
                  : progress.step === "sheet"
                    ? "Lägger trycken på ett ark…"
                    : progress.step === "draw"
                      ? "Ritar namn och nummer…"
                      : "Lägger i varukorgen…"}
            </div>
            <div style={{ ...S.small, marginTop: 8 }}>Namn, initialer och loggor trycks i 300 DPI på ett gemensamt ark och klipps ut åt er. Siffrorna i 20 och 25 cm tas från vårt lager.</div>
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
 * The list, one row per player. The round button in front of a row shows
 * it on the shirt; so does typing in it. On a phone the count is a plain
 * field: with steppers and initials the name got 24 px.
 */
function RosterTable({
  rows,
  showName,
  showNumber,
  showInitials,
  compact,
  selectedId,
  onSelect,
  onChange,
  onRemove,
  onAdd,
}: {
  rows: Row[];
  showName: boolean;
  showNumber: boolean;
  showInitials: boolean;
  compact: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onChange: (id: string, patch: Partial<Row>) => void;
  onRemove: (id: string) => void;
  onAdd: () => void;
}) {
  const cols = compact
    ? ["24px", showName ? "minmax(0, 1fr)" : "", showNumber ? "44px" : "", showInitials ? "48px" : "", "40px", "18px"]
    : ["28px", showName ? "minmax(0, 1fr)" : "", showNumber ? "56px" : "", showInitials ? "64px" : "", "92px", "24px"];
  const grid = { gridTemplateColumns: cols.filter(Boolean).join(" "), gap: compact ? 4 : 6 };
  const cell: React.CSSProperties = compact ? { padding: "10px 4px" } : {};
  return (
    <div>
      <div style={{ ...S.tableHead, ...grid, ...(compact ? { fontSize: 10, letterSpacing: "0.02em" } : null) }}>
        <span title="Visa på tröjan">Visa</span>
        {showName && <span>Namn</span>}
        {showNumber && <span>{compact ? "Nr" : "Nummer"}</span>}
        {showInitials && <span>{compact ? "Init." : "Initialer"}</span>}
        <span>Antal</span>
        <span />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {rows.map((r, i) => {
          const on = r.id === selectedId;
          return (
            <div key={r.id} style={{ display: "grid", ...grid, alignItems: "center" }} onFocus={() => onSelect(r.id)}>
              <button
                type="button"
                onClick={() => onSelect(r.id)}
                aria-pressed={on}
                aria-label={`Visa rad ${i + 1} på tröjan`}
                style={{ ...S.rowPick, ...(compact ? { width: 24, height: 24, fontSize: 11 } : null), ...(on ? S.rowPickOn : null) }}
              >
                {i + 1}
              </button>
              {showName && (
                <input
                  value={r.name}
                  onChange={(e) => onChange(r.id, { name: e.target.value.slice(0, 30) })}
                  placeholder={i === 0 ? "Andersson" : "Namn"}
                  aria-label={`Namn rad ${i + 1}`}
                  style={{ ...S.input, ...cell, ...(on ? S.inputOn : null) }}
                />
              )}
              {showNumber && (
                <input
                  value={r.number}
                  onChange={(e) => onChange(r.id, { number: e.target.value.replace(/[^\d]/g, "").slice(0, 3) })}
                  placeholder={i === 0 ? "10" : "#"}
                  inputMode="numeric"
                  aria-label={`Nummer rad ${i + 1}`}
                  style={{ ...S.input, ...cell, textAlign: "center", ...(on ? S.inputOn : null) }}
                />
              )}
              {showInitials && (
                <input
                  value={r.initials ?? ""}
                  onChange={(e) => onChange(r.id, { initials: cleanInitials(e.target.value) })}
                  placeholder={initialsOf(r.name) || (i === 0 ? "AA" : "")}
                  aria-label={`Initialer rad ${i + 1}`}
                  style={{ ...S.input, ...cell, textAlign: "center", ...(on ? S.inputOn : null) }}
                />
              )}
              {compact ? (
                <input
                  type="number"
                  min={1}
                  inputMode="numeric"
                  value={r.qty}
                  onChange={(e) => onChange(r.id, { qty: Math.max(1, Math.min(999, parseInt(e.target.value, 10) || 1)) })}
                  aria-label={`Antal rad ${i + 1}`}
                  style={{ ...S.input, ...cell, textAlign: "center", MozAppearance: "textfield" } as React.CSSProperties}
                />
              ) : (
                <Stepper value={r.qty} onChange={(v) => onChange(r.id, { qty: Math.max(1, v) })} label={`Antal rad ${i + 1}`} />
              )}
              <button type="button" onClick={() => onRemove(r.id)} style={S.remove} aria-label={`Ta bort rad ${i + 1}`}>
                ×
              </button>
            </div>
          );
        })}
      </div>
      <button type="button" onClick={onAdd} style={{ ...S.secondaryBtn, marginTop: 10 }}>
        + Lägg till rad
      </button>
    </div>
  );
}

function FileDrop({ onFile }: { onFile: (f: File) => void }) {
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
        accept=".xlsx,.csv,text/csv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
      <div style={{ fontWeight: 600, color: INK }}>Dra hit Excelfilen eller klicka</div>
      <div style={{ ...S.small, marginTop: 4 }}>Excel (.xlsx) eller CSV med kolumnerna Namn, Nummer, Initialer och Antal. Rubrikraden visar vilken kolumn som är vad.</div>
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
  cards3: { display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 },
  card: { display: "flex", flexDirection: "column", alignItems: "center", gap: 6, padding: "14px 8px 12px", border: `1px solid ${LINE}`, borderRadius: 12, background: "#fff", cursor: "pointer", font: "inherit", color: INK },
  cardOn: { border: `1.5px solid ${ACCENT}`, background: "rgba(220,47,60,0.05)", boxShadow: `0 0 0 1px ${ACCENT}` },
  cardSample: { fontSize: 18, fontWeight: 800, letterSpacing: "0.04em", whiteSpace: "nowrap" },
  cardLabel: { fontSize: 12.5, color: MUTED, fontWeight: 500 },
  styleSample: { display: "block", width: "100%", borderRadius: 8, fontSize: 44, lineHeight: "64px", height: 64, textAlign: "center", letterSpacing: 0 },
  swatches: { display: "flex", gap: 8, flexWrap: "wrap" },
  swatch: { width: 30, height: 30, borderRadius: "50%", border: "1px solid rgba(0,0,0,0.18)", padding: 0, cursor: "pointer" },
  swatchSmall: { width: 22, height: 22, borderRadius: "50%", border: "1px solid rgba(0,0,0,0.18)", padding: 0, cursor: "pointer" },
  link: { border: "none", background: "none", padding: 0, color: ACCENT, fontWeight: 600, cursor: "pointer", font: "inherit", textDecoration: "none" },
  // Longhands: chipOn and sizeChipOn change only the colour.
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
  sizeChip: { borderWidth: 1, borderStyle: "solid", borderColor: LINE, background: "#fff", color: INK, borderRadius: 999, padding: "4px 9px", fontSize: 12, cursor: "pointer", fontFamily: "inherit" },
  sizeChipOn: { background: INK, borderColor: INK, color: "#fff", fontWeight: 600 },
  input: {
    width: "100%",
    boxSizing: "border-box",
    padding: "10px 11px",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "rgba(0,0,0,0.16)",
    borderRadius: 10,
    font: "inherit",
    fontSize: 16,
    color: INK,
    background: "#fff",
    minWidth: 0,
  },
  inputOn: { borderColor: ACCENT },
  rowPick: { width: 28, height: 28, borderRadius: "50%", borderWidth: 1, borderStyle: "solid", borderColor: "rgba(0,0,0,0.16)", background: "#fff", color: MUTED, fontSize: 12, fontWeight: 600, cursor: "pointer", padding: 0, fontFamily: "inherit" },
  rowPickOn: { background: ACCENT, borderColor: ACCENT, color: "#fff" },
  option: { display: "flex", alignItems: "flex-start", gap: 10, marginTop: 12, padding: "10px 12px", border: `1px solid ${LINE}`, borderRadius: 12, cursor: "pointer", fontSize: 14 },
  qtyBox: { display: "flex", flexDirection: "column", gap: 6, border: `1px solid ${LINE}`, borderRadius: 12, padding: 10 },
  stepper: { display: "flex", alignItems: "center", justifyContent: "space-between", border: "1px solid rgba(0,0,0,0.16)", borderRadius: 10, padding: 2, height: 40, boxSizing: "border-box", background: "#fff", minWidth: 0, width: "100%" },
  stepBtn: { width: 24, height: 32, border: "none", background: "transparent", fontSize: 18, cursor: "pointer", color: INK, fontFamily: "inherit", padding: 0, flexShrink: 0 },
  stepInput: { width: "100%", minWidth: 0, border: "none", textAlign: "center", font: "inherit", fontSize: 16, fontVariantNumeric: "tabular-nums", background: "transparent", color: INK, MozAppearance: "textfield" } as React.CSSProperties,
  thumb: { width: 56, height: 46, borderRadius: 8, background: SOFT, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", fontSize: 11, color: MUTED, textAlign: "center", flexShrink: 0 },
  digit: { display: "flex", flexDirection: "column", gap: 6, border: `1px solid ${LINE}`, borderRadius: 12, padding: 6 },
  digitTile: { display: "block", borderRadius: 8, fontSize: 52, lineHeight: "76px", height: 76, textAlign: "center" },
  sponsorRow: { display: "grid", gap: 8, alignItems: "center", border: `1px solid ${LINE}`, borderRadius: 12, padding: 8 },
  remove: { width: 24, height: 32, border: "none", background: "transparent", color: "#a1a1a6", fontSize: 20, cursor: "pointer", padding: 0 },
  secondaryBtn: { borderWidth: 1, borderStyle: "solid", borderColor: "rgba(0,0,0,0.16)", background: "#fff", borderRadius: 10, padding: "10px 14px", cursor: "pointer", font: "inherit", fontSize: 13.5, fontWeight: 600, color: INK, height: 44 },
  note: { padding: "10px 12px", borderRadius: 10, background: "#fff8e6", border: "1px solid #f5d48a", color: "#7a4b00", fontSize: 13 },
  tabs: { display: "flex", gap: 4, padding: 3, borderRadius: 10, background: SOFT, marginBottom: 12 },
  tab: { flex: 1, border: "none", background: "transparent", padding: "8px 6px", borderRadius: 8, cursor: "pointer", fontFamily: "inherit", fontSize: 13, color: MUTED },
  tabOn: { background: "#fff", color: INK, fontWeight: 600, boxShadow: "0 1px 3px rgba(0,0,0,0.1)" },
  tableHead: { display: "grid", gap: 6, fontSize: 11.5, fontWeight: 600, color: MUTED, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6, padding: "0 2px" },
  textarea: { width: "100%", boxSizing: "border-box", padding: 12, border: "1px solid rgba(0,0,0,0.16)", borderRadius: 10, font: "inherit", fontSize: 16, lineHeight: 1.5, resize: "vertical", marginBottom: 6 },
  drop: { border: "2px dashed rgba(0,0,0,0.18)", borderRadius: 12, padding: "22px 14px", textAlign: "center", cursor: "pointer", background: "#fff" },
  summary: { border: `1px solid ${LINE}`, borderRadius: 16, padding: 16, background: "#fff", boxShadow: "0 8px 30px rgba(0,0,0,0.06)" },
  sumRow: { display: "flex", justifyContent: "space-between", gap: 10 },
  tiers: { display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 6 },
  tier: { display: "flex", flexDirection: "column", alignItems: "center", padding: "7px 4px", borderRadius: 10, background: SOFT, color: MUTED, fontSize: 13 },
  tierOn: { background: "rgba(46,125,50,0.1)", color: "#2e7d32" },
  primary: { width: "100%", border: "none", borderRadius: 12, background: ACCENT, color: "#fff", padding: "15px 16px", fontWeight: 700, fontSize: 15, cursor: "pointer", font: "inherit" },
  primaryOff: { background: "#e8e8ea", color: "#8e8e93", cursor: "not-allowed" },
  error: { marginTop: 10, padding: "10px 12px", borderRadius: 10, background: "#fff4ed", border: "1px solid #fed7aa", color: "#9a3412", fontSize: 13.5 },
  backdrop: { position: "fixed", inset: 0, background: "rgba(17,17,20,0.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 2147483000 },
  modal: { width: "100%", maxWidth: 400, background: "#fff", borderRadius: 18, padding: 22, boxShadow: "0 24px 80px rgba(0,0,0,0.25)", fontFamily: "inherit" },
  spinner: { display: "inline-block", width: 14, height: 14, borderRadius: "50%", border: `2px solid ${ACCENT}`, borderTopColor: "transparent", animation: "gs-nn-spin 0.8s linear infinite" },
};
