/**
 * TransferCraft Design System — 2026
 * Matches transfercraft.se: white base, dark header/accents, red CTA.
 * Inter font family. Clean, premium, modern.
 */
export const theme = {
  // Backgrounds
  bg: "#ffffff",
  bgSidebar: "#fafafa",
  bgCanvas: "#f5f5f5",
  bgCard: "#ffffff",
  bgInput: "#f5f5f5",
  bgGlass: "rgba(255, 255, 255, 0.85)",
  bgDark: "#1a1a1a",

  // Borders
  border: "rgba(0, 0, 0, 0.08)",
  borderHover: "rgba(0, 0, 0, 0.16)",
  borderStrong: "rgba(0, 0, 0, 0.12)",

  // Text
  text: "rgba(0, 0, 0, 0.81)",
  textMuted: "rgba(0, 0, 0, 0.55)",
  textDim: "rgba(0, 0, 0, 0.35)",
  textWhite: "#ffffff",

  // Primary — TransferCraft Red
  accent: "#e63946",
  accentHover: "#d32f3f",
  accentBg: "rgba(230, 57, 70, 0.06)",
  accentGradient: "linear-gradient(135deg, #e63946, #ff4757)",

  // Secondary — Dark
  secondary: "#1a1a1a",
  secondaryBg: "rgba(0, 0, 0, 0.04)",

  // Semantic
  danger: "#e63946",
  dangerBg: "rgba(230, 57, 70, 0.06)",
  success: "#2e7d32",
  successBg: "rgba(46, 125, 50, 0.06)",
  warning: "#e65100",
  warningBg: "rgba(230, 81, 0, 0.06)",

  // Canvas
  canvasWhite: "#ffffff",

  // Header — dark like Transfercraft nav
  headerBg: "#1a1a1a",

  // Shadows
  shadow: "0 1px 3px rgba(0, 0, 0, 0.06), 0 1px 2px rgba(0, 0, 0, 0.04)",
  shadowLg: "0 10px 40px rgba(0, 0, 0, 0.08)",

  // Radius — matching site's 14px buttons
  radius: 14,
  radiusSm: 8,
  radiusLg: 16,

  // ── Typography ──────────────────────────────────
  fontFamily: "Inter, system-ui, -apple-system, sans-serif",

  fontSize: {
    displayLg: "3.5rem",    // 56px
    headlineLg: "2rem",     // 32px
    headlineMd: "1.5rem",   // 24px
    titleLg: "1.125rem",    // 18px
    titleMd: "1rem",        // 16px
    bodyMd: "0.875rem",     // 14px
    bodySm: "0.8125rem",    // 13px
    labelLg: "0.8125rem",   // 13px
    labelMd: "0.75rem",     // 12px
    labelSm: "0.6875rem",   // 11px
    labelXs: "0.625rem",    // 10px
  },

  fontWeight: {
    regular: 400,
    medium: 500,
    semibold: 600,
    bold: 700,
  },

  letterSpacing: {
    tight: "-0.02em",
    normal: "0em",
    wide: "0.04em",
  },

  lineHeight: {
    tight: 1.2,
    normal: 1.5,
    relaxed: 1.6,
  },

  // ── Spacing scale (px) ────────────────────────
  space: {
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 24,
    "2xl": 32,
    "3xl": 40,
    "4xl": 48,
  },
} as const;
