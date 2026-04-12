import { useState } from "react";
import { useEditorStore } from "../../store/editorStore";
import {
  prepareForCart,
  saveGangSheet,
  createGangSheet,
  ensureGangSheet,
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
    currentPrice,
    setGangSheetId,
  } = useEditorStore();

  const handleAddToCart = async () => {
    if (images.length === 0) {
      alert("Lägg till minst en design innan du lägger i varukorgen.");
      return;
    }

    setIsAdding(true);

    try {
      // Step 1: Ensure gangSheet exists
      const gsId = await ensureGangSheet(
        sessionId,
        sheetSize.widthMm,
        sheetSize.heightMm,
        filmType,
        gangSheetId,
      );
      if (gsId !== gangSheetId) setGangSheetId(gsId);

      // Step 2: Save ALL image placements to the gang sheet
      // This ensures images are linked even if they weren't at upload time
      await saveGangSheet(gsId, {
        filmType,
        widthMm: sheetSize.widthMm,
        heightMm: sheetSize.heightMm,
        linkImages: true, // Signal to backend to link unlinked images
        images: images.map((img) => ({
          id: img.dbId || img.id,
          positionX: img.positionX,
          positionY: img.positionY,
          displayWidth: img.displayWidth,
          displayHeight: img.displayHeight,
          rotation: img.rotation,
          flipX: img.flipX,
          flipY: img.flipY,
          quantity: img.quantity,
        })),
      });

      // Step 3: Prepare for cart
      const cartData = await prepareForCart(gsId);
      const shopifyRoot = (window as any).Shopify?.routes?.root || "/";

      if (cartData.variantId) {
        const response = await fetch(`${shopifyRoot}cart/add.js`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            items: [
              {
                id: cartData.variantId,
                quantity: 1,
                properties: cartData.properties,
              },
            ],
          }),
        });

        if (!response.ok) {
          throw new Error("Kunde inte lägga till i varukorgen");
        }

        window.location.href = `${shopifyRoot}cart`;
      } else {
        // No variant mapped — show price info and let user know
        alert(
          `Arket är sparat (${cartData.price} kr). Variant-koppling saknas i inställningarna — kontakta admin.`,
        );
      }
    } catch (err) {
      console.error("Add to cart failed:", err);
      alert(`Fel: ${(err as Error).message}`);
    } finally {
      setIsAdding(false);
    }
  };

  const disabled = isAdding || images.length === 0;

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
        : `Lägg i varukorg — ${currentPrice} kr`}
    </button>
  );
}
