import { useState } from "react";
import { useEditorStore, getSheetsTotalPrice } from "../../store/editorStore";
import {
  prepareForCart,
  saveGangSheet,
  ensureGangSheet,
  buildPlacementsPayload,
} from "../../services/api";
import { theme } from "../../styles/theme";

export function AddToCartButton() {
  const [isAdding, setIsAdding] = useState(false);
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

  const handleAddToCart = async () => {
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

          // Step 3: Prepare for cart
          const cartData = await prepareForCart(gsId);
          if (!cartData.variantId) {
            throw new Error(
              "Variant-koppling saknas i inställningarna — kontakta admin.",
            );
          }
          items.push({
            id: cartData.variantId,
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
    <button
      onClick={handleAddToCart}
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
  );
}
