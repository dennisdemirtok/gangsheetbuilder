/**
 * Editing a sheet that is already in the cart.
 *
 * The cart line carries the sheet's id, so "edit" means: build the sheet again
 * and drop the line that the old version produced. The customer never has to
 * find and delete the old line themselves, and the cart never ends up with two
 * versions of the same design.
 */

const root = () => (window as any).Shopify?.routes?.root || "/";

/** Sheet ids the customer came here to replace, from ?edit=id1,id2 on the page URL. */
export function getEditTargets(): string[] {
  try {
    const value = new URLSearchParams(window.location.search).get("edit");
    if (!value) return [];
    return value
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Drop the line ?edit points at from the URL once it has been replaced. */
export function clearEditTarget() {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete("edit");
    window.history.replaceState({}, "", url.toString());
  } catch {
    // A URL we cannot rewrite is not worth failing an order over.
  }
}

/**
 * Remove every cart line that belongs to one of these sheets.
 * Runs before the new line is added, so the customer never sees both.
 */
export async function removeCartLinesForSheets(sheetIds: string[]): Promise<void> {
  const wanted = new Set(sheetIds.filter(Boolean));
  if (wanted.size === 0) return;

  try {
    const cart = await fetch(`${root()}cart.js`).then((response) => response.json());
    const doomed = (cart.items || []).filter((item: any) => {
      const props = item.properties || {};
      return wanted.has(props._gang_sheet_id) || wanted.has(props._sheet_id);
    });

    // One at a time: /cart/change.js renumbers lines, but a line key stays valid.
    for (const line of doomed) {
      await fetch(`${root()}cart/change.js`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: line.key, quantity: 0 }),
      });
    }
  } catch (error) {
    // Worst case the customer keeps the old line and can delete it by hand,
    // which is better than losing the new one.
    console.error("Could not remove the previous version of the sheet:", error);
  }
}
