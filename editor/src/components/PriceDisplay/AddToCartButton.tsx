import { useMemo, useState } from "react";
import { useEditorStore, getSheetsTotalPrice } from "../../store/editorStore";
import { computeSheetStats, type SheetIssue } from "../../utils/sheetStats";
import { getSheetVariantId } from "../../services/storefrontPrices";
import {
  prepareForCart,
  saveGangSheet,
  ensureGangSheet,
  buildPlacementsPayload,
} from "../../services/api";
import { theme } from "../../styles/theme";

export function AddToCartButton() {
  const [isAdding, setIsAdding] = useState(false);
  const [confirming, setConfirming] = useState<SheetIssue[] | null>(null);
  const {
    gangSheetId,
    sessionId,
    sheetSize,
    filmType,
    images,
    sheets,
    activeSheetIndex,
    prices,
    setSheetGangSheetId,
  } = useEditorStore();

  /**
   * Nothing used to stop a customer ordering designs that overlap, sit off
   * the film, or are too low-res to print — they found out when the parcel
   * arrived. Check first and make them acknowledge it.
   */
  const handleClick = () => {
    const stats = computeSheetStats(images, sheetSize);
    if (stats.issues.length > 0) {
      setConfirming(stats.issues);
      return;
    }
    void handleAddToCart();
  };

  const handleAddToCart = async () => {
    setConfirming(null);
    // Collect every sheet that has images. The active sheet's images live
    // in `images`; inactive sheets keep theirs in savedImages.
    const jobs = sheets
      .map((sheet, index) => {
        const isActive = index === activeSheetIndex;
        return {
          sheet,
          index,
          name: sheet.name || `Ark ${index + 1}`,
          sheetImages: isActive ? images : sheet.savedImages || [],
          size: isActive ? sheetSize : sheet.sheetSize ?? sheetSize,
          filmType: isActive ? filmType : sheet.filmType ?? filmType,
          gangSheetId: isActive ? gangSheetId : sheet.gangSheetId,
        };
      })
      .filter((job) => job.sheetImages.length > 0);

    if (jobs.length === 0) {
      alert("Lägg till minst en design innan du lägger i varukorgen.");
      return;
    }

    setIsAdding(true);

    try {
      // Prepare every sheet BEFORE touching the cart so a failure
      // never leaves a partial cart.
      const items: Array<{ id: string; quantity: number; properties: any }> = [];

      for (const job of jobs) {
        try {
          // Step 1: Ensure gangSheet exists for this sheet
          const gsId = await ensureGangSheet(
            sessionId,
            job.size.widthMm,
            job.size.heightMm,
            job.filmType,
            job.gangSheetId,
          );
          if (gsId !== job.gangSheetId) setSheetGangSheetId(job.index, gsId);

          // Step 2: Save this sheet's placements
          await saveGangSheet(
            gsId,
            buildPlacementsPayload(job.sheetImages, job.size, job.filmType),
          );

          // Step 3: Prepare for cart (persists the sheet, returns properties)
          const cartData = await prepareForCart(gsId);

          // Prefer the variant the theme rendered. The app's variantMapping
          // is optional config that nobody had filled in, which made every
          // single add-to-cart fail with "Variant-koppling saknas".
          const variantId =
            getSheetVariantId(job.size.key) ?? cartData.variantId ?? null;

          if (!variantId) {
            throw new Error(
              `Hittade ingen produktvariant för ${job.size.label}. ` +
                "Kontrollera att prisprodukten är vald i temat.",
            );
          }

          items.push({
            id: variantId,
            quantity: Math.max(1, job.sheet.quantity || 1),
            properties: cartData.properties,
          });
        } catch (err) {
          throw new Error(`${job.name}: ${(err as Error).message}`);
        }
      }

      // Step 4: Add ALL sheets to the Shopify cart in one batched call
      const shopifyRoot = (window as any).Shopify?.routes?.root || "/";
      const response = await fetch(`${shopifyRoot}cart/add.js`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      });

      if (!response.ok) {
        throw new Error("Kunde inte lägga till i varukorgen");
      }

      window.location.href = `${shopifyRoot}cart`;
    } catch (err) {
      console.error("Add to cart failed:", err);
      alert(`Fel: ${(err as Error).message}`);
    } finally {
      setIsAdding(false);
    }
  };

  const hasAnyImages =
    images.length > 0 ||
    sheets.some((s, i) => i !== activeSheetIndex && (s.savedImages?.length || 0) > 0);
  const disabled = isAdding || !hasAnyImages;

  const totalPrice = getSheetsTotalPrice(sheets, prices, sheetSize, filmType, activeSheetIndex, images.length);

  return (
    <>
      {confirming && (
        <IssueDialog
          issues={confirming}
          onCancel={() => setConfirming(null)}
          onProceed={() => void handleAddToCart()}
        />
      )}
      <button
        onClick={handleClick}
        disabled={disabled}
      style={{
        width: "100%",
        padding: "12px 16px",
        fontSize: 14,
        fontWeight: 700,
        border: "none",
        borderRadius: theme.radius,
        background: disabled
          ? theme.bgInput
          : theme.accentGradient,
        color: disabled ? theme.textDim : "#fff",
        cursor: disabled ? "not-allowed" : "pointer",
        transition: "all 0.2s",
        boxShadow: disabled ? "none" : `0 2px 12px ${theme.accent}50`,
      }}
    >
        {isAdding
          ? "Lägger i varukorg..."
          : `Lägg i varukorg — ${totalPrice !== null ? `${totalPrice} kr` : "—"}`}
      </button>
    </>
  );
}

/**
 * Last stop before the cart. Errors (overlap, off-sheet) get a blunt
 * warning; a low-DPI warning alone still lets the customer go ahead.
 */
function IssueDialog({
  issues,
  onCancel,
  onProceed,
}: {
  issues: SheetIssue[];
  onCancel: () => void;
  onProceed: () => void;
}) {
  const hasErrors = issues.some((i) => i.severity === "error");

  return (
    <div style={D.backdrop} onClick={onCancel}>
      <div style={D.modal} onClick={(e) => e.stopPropagation()}>
        <h3 style={D.title}>
          {hasErrors ? "Kontrollera arket först" : "Innan du beställer"}
        </h3>
        <p style={D.lead}>
          {hasErrors
            ? "Så här som arket ser ut nu kommer det att tryckas. Vill du fortsätta ändå?"
            : "Vi hittade något som kan påverka trycket:"}
        </p>
        <ul style={D.list}>
          {issues.map((issue, i) => (
            <li
              key={i}
              style={{
                ...D.item,
                color: issue.severity === "error" ? theme.danger : theme.warning,
              }}
            >
              {issue.message}
            </li>
          ))}
        </ul>
        <div style={D.actions}>
          <button onClick={onCancel} style={D.secondary}>
            Gå tillbaka och fixa
          </button>
          <button onClick={onProceed} style={D.primary}>
            Beställ ändå
          </button>
        </div>
      </div>
    </div>
  );
}

const D: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "fixed",
    inset: 0,
    background: "rgba(20,20,22,0.55)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
    zIndex: 60,
  },
  modal: {
    width: "100%",
    maxWidth: 420,
    background: theme.bg,
    borderRadius: theme.radiusLg,
    padding: 20,
    boxShadow: theme.shadowLg,
    fontFamily: theme.fontFamily,
  },
  title: {
    margin: 0,
    fontSize: theme.fontSize.titleMd,
    fontWeight: theme.fontWeight.bold,
    color: theme.text,
  },
  lead: {
    margin: "6px 0 12px",
    fontSize: theme.fontSize.bodySm,
    color: theme.textMuted,
    lineHeight: theme.lineHeight.normal,
  },
  list: { margin: 0, padding: "0 0 0 18px", display: "flex", flexDirection: "column", gap: 6 },
  item: { fontSize: theme.fontSize.bodySm, lineHeight: theme.lineHeight.normal },
  actions: { display: "flex", gap: 8, marginTop: 18 },
  secondary: {
    flex: 1,
    padding: "11px 12px",
    border: `1px solid ${theme.border}`,
    borderRadius: theme.radius,
    background: "transparent",
    color: theme.text,
    fontSize: theme.fontSize.bodySm,
    fontFamily: theme.fontFamily,
    fontWeight: theme.fontWeight.semibold,
    cursor: "pointer",
  },
  primary: {
    flex: 1,
    padding: "11px 12px",
    border: "none",
    borderRadius: theme.radius,
    background: theme.accent,
    color: "#fff",
    fontSize: theme.fontSize.bodySm,
    fontFamily: theme.fontFamily,
    fontWeight: theme.fontWeight.semibold,
    cursor: "pointer",
  },
};
