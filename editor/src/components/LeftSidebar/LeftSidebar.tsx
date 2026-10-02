import { useState } from "react";
import { ImageUploader } from "../ImagePanel/ImageUploader";
import { ImageList } from "../ImagePanel/ImageList";
import { TextTab } from "./TextTab";
import { REDO_KEYS, UNDO_KEYS } from "../../store/history";
import { useEditorStore, groupImages } from "../../store/editorStore";
import {
  EDGE_MARGIN_MM,
  GAP_PRESETS,
  GAP_PRESET_LABELS,
  gapPresetFromMm,
  type GapPreset,
} from "../../utils/layout";
import { theme } from "../../styles/theme";

export type TabKey = "designs" | "text" | "settings";

// SVG icon components for clean look
const Icons = {
  designs: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>`,
  uploads: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`,
  text: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>`,
  settings: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
};

export const TABS: { key: TabKey; label: string; icon: string }[] = [
  { key: "designs", label: "Designs", icon: Icons.designs },
  { key: "text", label: "Text", icon: Icons.text },
  { key: "settings", label: "Inställningar", icon: Icons.settings },
];

export function LeftSidebar() {
  const [activeTab, setActiveTab] = useState<TabKey>("designs");
  const { isUploading } = useEditorStore();

  return (
    <aside
      style={{
        background: theme.bg,
        display: "flex",
        overflow: "hidden",
      }}
    >
      {/* Icon tab bar — dark strip */}
      <div
        style={{
          width: 72,
          background: theme.bgDark,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          paddingTop: theme.space.lg,
          gap: 4,
          flexShrink: 0,
        }}
      >
        {TABS.map((tab) => {
          const active = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              title={tab.label}
              style={{
                width: 60,
                padding: "10px 0 7px",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 4,
                border: "none",
                borderRadius: theme.radiusSm,
                background: active ? "rgba(255,255,255,0.12)" : "transparent",
                color: active ? "#fff" : "rgba(255,255,255,0.5)",
                cursor: "pointer",
                transition: "all 0.15s",
              }}
            >
              <span dangerouslySetInnerHTML={{ __html: tab.icon }} />
              <span
                style={{
                  fontSize: "10px",
                  fontWeight: active ? theme.fontWeight.semibold : theme.fontWeight.regular,
                  fontFamily: theme.fontFamily,
                  letterSpacing: "0.01em",
                }}
              >
                {tab.label}
              </span>
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          background: theme.bgSidebar,
        }}
      >
        <TabContent tab={activeTab} />
      </div>
    </aside>
  );
}

/**
 * The panel body on its own, so the mobile shell can show the same tabs
 * in a bottom drawer instead of a fixed sidebar.
 */
export function TabContent({ tab }: { tab: TabKey }) {
  const { isUploading } = useEditorStore();
  return (
    <>
      {tab === "designs" && <DesignsTab isUploading={isUploading} />}
      {tab === "text" && <TextTab />}
      {tab === "settings" && <SettingsTab />}
    </>
  );
}

function DesignsTab({ isUploading }: { isUploading: boolean }) {
  return (
    <>
      <TabHeader title="Designs" />
      <div
        style={{
          flex: 1,
          overflow: "auto",
          padding: `0 ${theme.space.lg}px ${theme.space.lg}px`,
          display: "flex",
          flexDirection: "column",
          gap: theme.space.sm,
        }}
      >
        <ImageUploader />
        {isUploading && (
          <div
            style={{
              padding: theme.space.md,
              textAlign: "center",
              background: theme.accentBg,
              borderRadius: theme.radiusSm,
              fontSize: theme.fontSize.bodySm,
              color: theme.accent,
            }}
          >
            Laddar upp...
          </div>
        )}
        <ImageList />
      </div>
    </>
  );
}

function SettingsTab() {
  const { sheetSize, gapMm, setGapMm } = useEditorStore();
  const activePreset = gapPresetFromMm(gapMm);

  return (
    <>
      <TabHeader title="Inställningar" />
      <div
        style={{
          flex: 1,
          overflow: "auto",
          padding: theme.space.lg,
          display: "flex",
          flexDirection: "column",
          gap: theme.space.lg,
        }}
      >
        {/* One gap for the whole sheet. It used to be a per-design field
            that disagreed with what auto-arrange and the export actually used. */}
        <div>
          <label style={{ fontSize: theme.fontSize.labelMd, color: theme.textMuted, fontWeight: theme.fontWeight.semibold }}>
            Avstånd mellan motiv
          </label>
          <div style={{ display: "flex", gap: 6, marginTop: theme.space.sm }}>
            {(Object.keys(GAP_PRESETS) as GapPreset[]).map((key) => {
              const active = activePreset === key;
              return (
                <button
                  key={key}
                  onClick={() => setGapMm(GAP_PRESETS[key])}
                  style={{
                    flex: 1,
                    padding: "8px 4px",
                    border: `1px solid ${active ? theme.accent : theme.border}`,
                    borderRadius: theme.radiusSm,
                    background: active ? theme.accentBg : theme.bgCard,
                    color: active ? theme.accent : theme.textMuted,
                    fontSize: theme.fontSize.labelMd,
                    fontFamily: theme.fontFamily,
                    fontWeight: active ? theme.fontWeight.semibold : theme.fontWeight.regular,
                    cursor: "pointer",
                  }}
                >
                  {GAP_PRESET_LABELS[key]}
                  <span style={{ display: "block", fontSize: theme.fontSize.labelXs, color: theme.textDim }}>
                    {GAP_PRESETS[key]} mm
                  </span>
                </button>
              );
            })}
          </div>
          <p style={{ margin: `${theme.space.sm}px 0 0`, fontSize: theme.fontSize.labelMd, color: theme.textDim, lineHeight: theme.lineHeight.normal }}>
            Utrymmet du klipper i mellan motiven. 5 mm räcker för att klippa
            isär utan att skada grannen.
          </p>
        </div>

        <div>
          <label style={{ fontSize: theme.fontSize.labelMd, color: theme.textMuted, fontWeight: theme.fontWeight.semibold }}>
            Marginal mot kanten
          </label>
          <p style={{ margin: `${theme.space.xs}px 0 0`, fontSize: theme.fontSize.bodyMd, fontWeight: theme.fontWeight.semibold }}>
            {EDGE_MARGIN_MM} mm
          </p>
          <p style={{ margin: `${theme.space.xs}px 0 0`, fontSize: theme.fontSize.labelMd, color: theme.textDim, lineHeight: theme.lineHeight.normal }}>
            Fast värde. Ytterkanten av filmen är opålitlig att trycka på, så
            inga motiv placeras där.
          </p>
        </div>

        <div>
          <label style={{ fontSize: theme.fontSize.labelMd, color: theme.textMuted, fontWeight: theme.fontWeight.semibold }}>
            Aktuellt ark
          </label>
          <p style={{ margin: `${theme.space.xs}px 0 0`, fontSize: theme.fontSize.bodyMd, fontWeight: theme.fontWeight.semibold }}>
            {sheetSize.label}
          </p>
          <p style={{ margin: `${theme.space.xs}px 0 0`, fontSize: theme.fontSize.labelMd, color: theme.textDim }}>
            Bredd: 58 cm | Export: 300 DPI PNG
          </p>
        </div>

        <div>
          <label style={{ fontSize: theme.fontSize.labelMd, color: theme.textMuted, fontWeight: theme.fontWeight.semibold }}>
            Tangentbordsgenvägar
          </label>
          <div style={{ marginTop: theme.space.sm, fontSize: theme.fontSize.labelMd, color: theme.textDim, display: "flex", flexDirection: "column", gap: 4 }}>
            <Shortcut keys={UNDO_KEYS} label="Ångra" />
            <Shortcut keys={REDO_KEYS} label="Gör om" />
            <Shortcut keys="Delete" label="Ta bort markerad" />
            <Shortcut keys="Ctrl+D" label="Duplicera" />
            <Shortcut keys="Esc" label="Stäng editor" />
          </div>
        </div>
      </div>
    </>
  );
}

function TabHeader({ title }: { title: string }) {
  return (
    <div
      style={{
        padding: `${theme.space.lg}px ${theme.space.lg}px ${theme.space.sm}px`,
        fontSize: theme.fontSize.bodySm,
        fontWeight: theme.fontWeight.semibold,
        textTransform: "uppercase" as const,
        letterSpacing: theme.letterSpacing.wide,
        color: theme.textMuted,
      }}
    >
      {title}
    </div>
  );
}

function Shortcut({ keys, label }: { keys: string; label: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between" }}>
      <span>{label}</span>
      <code
        style={{
          fontSize: theme.fontSize.labelXs,
          padding: "1px 6px",
          background: theme.bgInput,
          borderRadius: theme.radiusSm,
          color: theme.textMuted,
        }}
      >
        {keys}
      </code>
    </div>
  );
}
