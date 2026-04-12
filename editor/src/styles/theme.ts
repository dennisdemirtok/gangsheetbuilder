/**
 * "Precision Industrialism" Design System — 2026
 * Light-mode, clinical, premium. Coral-red accent.
 * Plus Jakarta Sans. No hard borders — tonal layering only.
 */
export const theme = {
  // Backgrounds — tonal layering
  bg: "#f7f9fb",
  bgSidebar: "#e6e8ea",
  bgCanvas: "#f2f4f6",
  bgCard: "#ffffff",
  bgInput: "#f2f4f6",
  bgGlass: "rgba(255, 255, 255, 0.7)",

  // Borders — ghost borders only (15% opacity)
  border: "rgba(25, 28, 30, 0.08)",
  borderHover: "rgba(25, 28, 30, 0.15)",

  // Text — never pure black
  text: "#191c1e",
  textMuted: "#4f6071",
  textDim: "#8a9199",

  // Primary — TransferCraft Coral
  accent: "#bb0018",
  accentHover: "#d4001c",
  accentBg: "rgba(187, 0, 24, 0.06)",
  accentGradient: "linear-gradient(135deg, #bb0018, #e8002a)",

  // Secondary — Industrial Slate
  secondary: "#4f6071",
  secondaryBg: "rgba(79, 96, 113, 0.08)",

  // Semantic
  danger: "#c62828",
  dangerBg: "rgba(198, 40, 40, 0.06)",
  success: "#2e7d32",
  successBg: "rgba(46, 125, 50, 0.06)",
  warning: "#e65100",
  warningBg: "rgba(230, 81, 0, 0.06)",

  // Canvas
  canvasWhite: "#ffffff",

  // Header — glassmorphism
  headerBg: "rgba(255, 255, 255, 0.7)",

  // Shadows — ambient occlusion, tinted not black
  shadow: "0 2px 12px rgba(25, 28, 30, 0.04)",
  shadowLg: "0 10px 40px rgba(25, 28, 30, 0.06)",

  // Radius — industrial precision
  radius: 6,
  radiusSm: 2,
  radiusLg: 12,

  // ── Typography ──────────────────────────────────
  fontFamily: "'Plus Jakarta Sans', 'Inter', system-ui, -apple-system, sans-serif",

  // Type scale (rem-based, root = 16px)
  fontSize: {
    displayLg: "3.5rem",    // 56px — hero headlines
    headlineLg: "2rem",     // 32px — section headers
    headlineMd: "1.5rem",   // 24px — card titles
    titleLg: "1.125rem",    // 18px — panel titles
    titleMd: "1rem",        // 16px — buttons, large labels
    bodyMd: "0.875rem",     // 14px — primary body text
    bodySm: "0.8125rem",    // 13px — compact body text
    labelLg: "0.8125rem",   // 13px — form labels
    labelMd: "0.75rem",     // 12px — metadata, badges
    labelSm: "0.6875rem",   // 11px — smallest readable
    labelXs: "0.625rem",    // 10px — micro labels
  },

  // Font weights
  fontWeight: {
    regular: 400,
    medium: 500,
    semibold: 600,
    bold: 700,
  },

  // Letter spacing
  letterSpacing: {
    tight: "-0.02em",       // headlines
    normal: "0em",          // body
    wide: "0.04em",         // section labels, uppercase
  },

  // Line heights
  lineHeight: {
    tight: 1.2,             // headlines
    normal: 1.5,            // body
    relaxed: 1.6,           // long-form
  },

  // ── Spacing scale (px) ────────────────────────
  space: {
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 20,
    "2xl": 24,
    "3xl": 32,
    "4xl": 40,
  },
} as const;
