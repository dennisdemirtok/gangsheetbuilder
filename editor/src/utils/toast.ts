/**
 * A short message in the corner of the screen. Plain DOM, so the store can
 * tell the customer what it did (the sheet grew, a size change was refused)
 * without a component in between.
 */
export function showToast(message: string, type: "warning" | "error" | "info" | "success") {
  const colors = {
    warning: { bg: "#fef3c7", border: "#fbbf24", text: "#92400e" },
    error: { bg: "#fef2f2", border: "#f87171", text: "#991b1b" },
    info: { bg: "#eff6ff", border: "#60a5fa", text: "#1e40af" },
    success: { bg: "#f0fdf4", border: "#4ade80", text: "#166534" },
  };
  const c = colors[type];

  const toast = document.createElement("div");
  toast.textContent = message;
  toast.style.cssText = `
    position: fixed; top: 16px; right: 16px; z-index: 9999;
    padding: 12px 16px; max-width: 360px;
    background: ${c.bg}; border: 1px solid ${c.border}; color: ${c.text};
    border-radius: 8px; font-size: 13px; font-family: system-ui;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    animation: gs-toast-in 0.3s ease-out;
  `;

  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transition = "opacity 0.3s";
    setTimeout(() => toast.remove(), 300);
  }, 5000);
}
