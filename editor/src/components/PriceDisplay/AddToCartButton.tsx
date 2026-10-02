import { useMemo, useState } from "react";
import { useEditorStore, getSheetsTotalPrice } from "../../store/editorStore";
import { computeSheetStats, type SheetIssue } from "../../utils/sheetStats";
import { getSheetCartLine, getSheetPrice } from "../../services/storefrontPrices";
import {
  prepareForCart,
  saveGangSheet,
  ensureGangSheet,
  buildPlacementsPayload,
} from "../../services/api";
import {
  getEditTargets,
  removeCartLinesForSheets,
} from "../../services/cart";
import { theme } from "../../styles/theme";
import { showToast } from "../../utils/toast";

/** A sheet's problems, labelled with the sheet when there are several. */
interface SheetCheck {
  index: number;
  issues: SheetIssue[];
}

/**
 * Every sheet in the cart, not only the one on screen: a second sheet with
 * piled-up designs used to go to print unchecked.
 */
function checkAllSheets(): SheetCheck[] {
  const state = useEditorStore.getState();
  return state.sheets
    .map((sheet, index) => {
      const active = index === state.activeSheetIndex;
      const sheetImages = active ? state.images : sheet.savedImages || [];
      const size = active ? state.sheetSize : sheet.sheetSize ?? state.sheetSize;
      return { index, issues: sheetImages.length ? computeSheetStats(sheetImages, size).issues : [] };
    })
    .filter((c) => c.issues.length > 0);
}

function labelled(checks: SheetCheck[]): SheetIssue[] {
  const { sheets } = useEditorStore.getState();
  return checks.flatMap((c) =>
    c.issues.map((issue) =>
      sheets.length > 1
        ? { ...issue, message: `${sheets[c.index]?.name ?? `Ark ${c.index + 1}`}: ${issue.message}` }
        : issue,
    ),
  );
}

/**
 * Re-arrange every sheet that has designs on top of each other or off the
 * film, lengthening it where needed. The customer then sees the result —
 * and the new price — before anything goes in the cart.
 */
async function fixSheets(checks: SheetCheck[]): Promise<SheetCheck[]> {
  const store = useEditorStore.getState();
  const original = store.activeSheetIndex;
  for (const check of checks) {
    if (!check.issues.some((i) => i.severity === "error")) continue;
    useEditorStore.getState().switchSheet(check.index);
    await useEditorStore.getState().arrangeSheet();
  }
  useEditorStore.getState().switchSheet(original);
  return checkAllSheets();
}

export function AddToCartButton() {
  const [isAdding, setIsAdding] = useState(false);
  const [confirming, setConfirming] = useState<SheetCheck[] | null>(null);
  const [fixing, setFixing] = useState(false);
  const [fixFailed, setFixFailed] = useState(false);
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
    const checks = checkAllSheets();
    if (checks.length > 0) {
      setFixFailed(false);
      setConfirming(checks);
      return;
    }
    void handleAddToCart();
  };

  const handleFix = async () => {
    if (!confirming) return;
    setFixing(true);
    try {
      const left = await fixSheets(confirming);
      const errorsLeft = left.some((c) => c.issues.some((i) => i.severity === "error"));
      if (!errorsLeft) {
        setConfirming(null);
        showToast("Klart! Kontrollera arket och priset, och lägg sedan i varukorgen.", "success");
      } else {
        setFixFailed(true);
        setConfirming(left);
      }
    } finally {
      setFixing(false);
    }
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
          const cartData = await prepareForCart(
            gsId,
            getSheetPrice(job.size.key),
          );

          // The variant the theme rendered: a whole metre has its own, any
          // other length is decimetres of the per-decimetre variant. The
          // app's variantMapping is optional config nobody filled in, which
          // made every add-to-cart fail with "Variant-koppling saknas".
          const copies = Math.max(1, job.sheet.quantity || 1);
          const line = getSheetCartLine(job.size.key, copies);
          const fallbackId = cartData.variantId ?? null;

          if (!line && !fallbackId) {
            throw new Error(
              `Hittade ingen produktvariant för ${job.size.label}. ` +
                "Kontrollera att prisprodukten är vald i temat.",
            );
          }

          items.push(
            line
              ? { id: line.variantId, quantity: line.quantity, properties: { ...cartData.properties, ...line.properties } }
              : { id: fallbackId, quantity: copies, properties: cartData.properties },
          );
        } catch (err) {
          throw new Error(`${job.name}: ${(err as Error).message}`);
        }
      }

      // Step 4: if these sheets are already in the cart, drop the old lines first,
      // so editing replaces the design instead of adding a second copy of it.
      const replacedIds = [
        ...getEditTargets(),
        ...items.map((item) => item.properties?._gang_sheet_id).filter(Boolean),
      ];
      await removeCartLinesForSheets(replacedIds);

      // Step 5: Add ALL sheets to the Shopify cart in one batched call
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
          issues={labelled(confirming)}
          fixing={fixing}
          fixFailed={fixFailed}
          onCancel={() => setConfirming(null)}
          onFix={() => void handleFix()}
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
 * Last stop before the cart.
 *
 * Designs on top of each other or off the film print wrong, and an "order
 * anyway" button here was clicked through: #1024 was paid for as 1 m with
 * 2 m of logos piled onto it. Those errors now only offer the fix — which
 * re-arranges and, if needed, lengthens the sheet at its real price. Low
 * resolution and touching corners are warnings the customer may accept.
 */
function IssueDialog({
  issues,
  fixing,
  fixFailed,
  onCancel,
  onFix,
  onProceed,
}: {
  issues: SheetIssue[];
  fixing: boolean;
  fixFailed: boolean;
  onCancel: () => void;
  onFix: () => void;
  onProceed: () => void;
}) {
  const errors = issues.filter((i) => i.severity === "error");
  const hasErrors = errors.length > 0;

  return (
    <div style={D.backdrop} onClick={fixing ? undefined : onCancel}>
      <div style={D.modal} onClick={(e) => e.stopPropagation()}>
        <h3 style={D.title}>
          {hasErrors ? "Arket behöver fixas" : "Innan du beställer"}
        </h3>
        <p style={D.lead}>
          {hasErrors
            ? "Motiv som ligger på varandra eller utanför filmen trycks fel. Vi kan ordna dem åt dig — arket blir längre om allt inte får plats, och du ser det nya priset innan du lägger i varukorgen."
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
        {/* Still wrong after a fix: more than the longest sheet holds. */}
        {hasErrors && fixFailed && !fixing && (
          <p style={{ ...D.lead, margin: "12px 0 0" }}>
            Får det inte plats ens på 5 meter? Lägg en del av motiven på ett nytt
            ark under Ark, eller gör dem mindre.
          </p>
        )}
        <div style={D.actions}>
          <button onClick={onCancel} style={D.secondary} disabled={fixing}>
            Gå tillbaka
          </button>
          {hasErrors ? (
            <button onClick={onFix} style={{ ...D.primary, opacity: fixing ? 0.7 : 1 }} disabled={fixing}>
              {fixing ? "Ordnar arket…" : "Fixa automatiskt"}
            </button>
          ) : (
            <button onClick={onProceed} style={D.primary}>
              Beställ ändå
            </button>
          )}
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
