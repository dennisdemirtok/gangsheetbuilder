import { useEffect, useMemo, useState } from "react";
import {
  useEditorStore,
  getSheetsTotalPrice,
  groupImages,
  type EditorImage,
  type SheetEntry,
  type SheetSize,
} from "../../store/editorStore";
import { computeSheetStats, type SheetIssue } from "../../utils/sheetStats";
import { getSheetCartLine, getSheetPrice } from "../../services/storefrontPrices";
import {
  prepareForCart,
  saveGangSheet,
  ensureGangSheet,
  buildPlacementsPayload,
} from "../../services/api";
import {
  clearEditTarget,
  getEditTargets,
  removeCartLinesForSheets,
} from "../../services/cart";
import { imageBbox } from "../../utils/layout";
import { SheetPreview, type PreviewPiece } from "../StartWizard/SheetPreview";
import { theme } from "../../styles/theme";
import { showToast } from "../../utils/toast";

/**
 * From "Lägg i varukorg" to the cart, in steps the customer can follow:
 *
 *   1. Check every sheet. Designs on top of each other or off the film
 *      block the order until they are fixed (one click re-arranges).
 *   2. Confirm: what is being ordered, sheet by sheet with a picture, the
 *      total, an optional name for the order and a required tick that the
 *      customer may print the artwork — brand logos are the usual trouble.
 *   3. Progress while the sheets are saved and put in the cart.
 *   4. A clear "added" before going to the cart.
 *
 * The button used to say "Lägger i varukorg..." and then either jumped to
 * the cart or showed a browser alert.
 */

interface SheetJob {
  sheet: SheetEntry;
  index: number;
  name: string;
  sheetImages: EditorImage[];
  size: SheetSize;
  filmType: string;
  gangSheetId: string | null;
}

/** Every sheet that has designs. The one on screen keeps them in `images`. */
function collectJobs(): SheetJob[] {
  const s = useEditorStore.getState();
  return s.sheets
    .map((sheet, index) => {
      const active = index === s.activeSheetIndex;
      return {
        sheet,
        index,
        name: sheet.name || `Ark ${index + 1}`,
        sheetImages: active ? s.images : sheet.savedImages || [],
        size: active ? s.sheetSize : sheet.sheetSize ?? s.sheetSize,
        filmType: active ? s.filmType : sheet.filmType ?? s.filmType,
        gangSheetId: active ? s.gangSheetId : sheet.gangSheetId,
      };
    })
    .filter((job) => job.sheetImages.length > 0);
}

interface SheetCheck {
  index: number;
  name: string;
  images: EditorImage[];
  issues: SheetIssue[];
}

/**
 * Every sheet in the cart, not only the one on screen: a second sheet with
 * piled-up designs used to go to print unchecked.
 */
function checkAllSheets(): SheetCheck[] {
  return collectJobs()
    .map((job) => ({
      index: job.index,
      name: job.name,
      images: job.sheetImages,
      issues: computeSheetStats(job.sheetImages, job.size).issues,
    }))
    .filter((c) => c.issues.length > 0);
}

/**
 * Re-arrange every sheet that has designs on top of each other or off the
 * film, lengthening it where needed. The customer then sees the result —
 * and the new price — before anything goes in the cart.
 */
async function fixSheets(checks: SheetCheck[]): Promise<SheetCheck[]> {
  const original = useEditorStore.getState().activeSheetIndex;
  for (const check of checks) {
    if (!check.issues.some((i) => i.severity === "error")) continue;
    useEditorStore.getState().switchSheet(check.index);
    await useEditorStore.getState().arrangeSheet();
  }
  useEditorStore.getState().switchSheet(original);
  return checkAllSheets();
}

type Phase =
  | { kind: "idle" }
  | { kind: "issues"; checks: SheetCheck[]; fixing: boolean; fixFailed: boolean }
  | { kind: "confirm"; jobs: SheetJob[] }
  | { kind: "adding"; jobs: SheetJob[]; name: string; done: number; total: number; step: number; error?: string }
  | { kind: "added"; jobs: SheetJob[]; name: string };

function piecesOf(jobs: SheetJob[]): number {
  return jobs.reduce((n, j) => n + j.sheetImages.length, 0);
}

function jobPrice(job: SheetJob): number | null {
  const unit = getSheetPrice(job.size.key);
  return unit === null ? null : unit * Math.max(1, job.sheet.quantity || 1);
}

export function AddToCartButton() {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const { sheetSize, filmType, images, sheets, activeSheetIndex, prices } = useEditorStore();

  const start = () => {
    const checks = checkAllSheets();
    if (checks.length > 0) {
      setPhase({ kind: "issues", checks, fixing: false, fixFailed: false });
      return;
    }
    openConfirm();
  };

  const openConfirm = () => {
    const jobs = collectJobs();
    if (jobs.length === 0) {
      showToast("Lägg till minst ett motiv innan du lägger i varukorgen.", "warning");
      setPhase({ kind: "idle" });
      return;
    }
    setPhase({ kind: "confirm", jobs });
  };

  const fix = async (checks: SheetCheck[]) => {
    setPhase({ kind: "issues", checks, fixing: true, fixFailed: false });
    const left = await fixSheets(checks);
    if (!left.some((c) => c.issues.some((i) => i.severity === "error"))) {
      setPhase({ kind: "idle" });
      showToast("Klart! Kontrollera arket och priset, och lägg sedan i varukorgen.", "success");
    } else {
      setPhase({ kind: "issues", checks: left, fixing: false, fixFailed: true });
    }
  };

  const addToCart = async (jobs: SheetJob[], name: string) => {
    const total = jobs.length * 2 + 1;
    let done = 0;
    const report = (step: number) => setPhase({ kind: "adding", jobs, name, done, total, step });
    report(0);

    try {
      // Prepare every sheet BEFORE touching the cart so a failure never
      // leaves a partial cart.
      const items: Array<{ id: string; quantity: number; properties: Record<string, string> }> = [];
      const confirmedAt = new Date().toISOString();

      for (const job of jobs) {
        try {
          const gsId = await ensureGangSheet(
            useEditorStore.getState().sessionId,
            job.size.widthMm,
            job.size.heightMm,
            job.filmType,
            job.gangSheetId,
          );
          if (gsId !== job.gangSheetId) useEditorStore.getState().setSheetGangSheetId(job.index, gsId);
          await saveGangSheet(gsId, buildPlacementsPayload(job.sheetImages, job.size, job.filmType));
          done++;
          report(1);

          const cartData = await prepareForCart(gsId, getSheetPrice(job.size.key));
          done++;
          report(jobs.indexOf(job) === jobs.length - 1 ? 2 : 1);

          // The variant the theme rendered: a whole metre has its own, any
          // other length is decimetres of the per-decimetre variant.
          const copies = Math.max(1, job.sheet.quantity || 1);
          const line = getSheetCartLine(job.size.key, copies);
          const fallbackId = cartData.variantId ?? null;
          if (!line && !fallbackId) {
            throw new Error(
              `Hittade ingen produktvariant för ${job.size.label}. Kontrollera att prisprodukten är vald i temat.`,
            );
          }
          const properties: Record<string, string> = {
            ...cartData.properties,
            ...(line ? line.properties : {}),
            ...(name ? { Designnamn: name } : {}),
            // Hidden on the order: when the customer ticked that they may
            // print the artwork.
            _rights_confirmed: confirmedAt,
          };
          items.push(
            line
              ? { id: line.variantId, quantity: line.quantity, properties }
              : { id: fallbackId, quantity: copies, properties },
          );
        } catch (err) {
          throw new Error(`${job.name}: ${(err as Error).message}`);
        }
      }

      // Editing a sheet already in the cart replaces its line instead of
      // adding a second copy.
      const replacedIds = [
        ...getEditTargets(),
        ...items.map((item) => item.properties?._gang_sheet_id).filter(Boolean),
      ];
      await removeCartLinesForSheets(replacedIds);

      const shopifyRoot = (window as any).Shopify?.routes?.root || "/";
      const response = await fetch(`${shopifyRoot}cart/add.js`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      });
      if (!response.ok) throw new Error("Varukorgen svarade inte. Försök igen om en stund.");

      clearEditTarget();
      setPhase({ kind: "added", jobs, name });
      window.setTimeout(() => {
        window.location.href = `${shopifyRoot}cart`;
      }, 1400);
    } catch (err) {
      console.error("Add to cart failed:", err);
      setPhase({ kind: "adding", jobs, name, done, total, step: -1, error: (err as Error).message });
    }
  };

  const hasAnyImages =
    images.length > 0 ||
    sheets.some((s, i) => i !== activeSheetIndex && (s.savedImages?.length || 0) > 0);
  const busy = phase.kind === "adding" || phase.kind === "added";
  const disabled = busy || !hasAnyImages;
  const totalPrice = getSheetsTotalPrice(sheets, prices, sheetSize, filmType, activeSheetIndex, images.length);

  return (
    <>
      {phase.kind === "issues" && (
        <IssueDialog
          checks={phase.checks}
          fixing={phase.fixing}
          fixFailed={phase.fixFailed}
          onCancel={() => setPhase({ kind: "idle" })}
          onFix={() => void fix(phase.checks)}
          onProceed={openConfirm}
        />
      )}
      {phase.kind === "confirm" && (
        <ConfirmDialog
          jobs={phase.jobs}
          onCancel={() => setPhase({ kind: "idle" })}
          onConfirm={(name) => void addToCart(phase.jobs, name)}
        />
      )}
      {phase.kind === "adding" && (
        <ProgressDialog
          phase={phase}
          onRetry={() => setPhase({ kind: "confirm", jobs: phase.jobs })}
          onClose={() => setPhase({ kind: "idle" })}
        />
      )}
      {phase.kind === "added" && <AddedDialog jobs={phase.jobs} name={phase.name} />}

      <button
        onClick={start}
        disabled={disabled}
        style={{
          width: "100%",
          padding: "13px 16px",
          fontSize: 14,
          fontWeight: 700,
          fontFamily: theme.fontFamily,
          border: "none",
          borderRadius: theme.radius,
          background: disabled ? theme.bgInput : theme.accentGradient,
          color: disabled ? theme.textDim : "#fff",
          cursor: disabled ? "not-allowed" : "pointer",
          transition: "all 0.2s",
          boxShadow: disabled ? "none" : `0 2px 12px ${theme.accent}50`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
        }}
      >
        <span dangerouslySetInnerHTML={{ __html: CART_ICON }} style={{ display: "flex" }} />
        {busy ? "Lägger i varukorgen…" : `Lägg i varukorg${totalPrice !== null ? ` · ${totalPrice} kr` : ""}`}
      </button>
    </>
  );
}

const CART_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M2.5 3.5h2.6l2.4 11.2a1.5 1.5 0 0 0 1.5 1.2h8.9a1.5 1.5 0 0 0 1.5-1.1l1.6-7.3H6.2"/></svg>`;

/* ───────────────────────────── Dialogs ───────────────────────────── */

function Modal({
  title,
  lead,
  icon,
  tone = "default",
  onClose,
  children,
  width = 460,
}: {
  title: string;
  lead?: string;
  icon?: string;
  tone?: "default" | "warning" | "success";
  onClose?: () => void;
  children: React.ReactNode;
  width?: number;
}) {
  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const color = tone === "warning" ? "#c2410c" : tone === "success" ? theme.success : theme.text;
  return (
    <div style={D.backdrop} onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={title} style={{ ...D.modal, maxWidth: width }} onClick={(e) => e.stopPropagation()}>
        <div style={D.head}>
          <h3 style={{ ...D.title, color }}>
            {icon && <span dangerouslySetInnerHTML={{ __html: icon }} style={{ display: "flex" }} />}
            {title}
          </h3>
          {onClose && (
            <button onClick={onClose} style={D.close} aria-label="Stäng">
              ×
            </button>
          )}
        </div>
        {lead && <p style={D.lead}>{lead}</p>}
        {children}
      </div>
    </div>
  );
}

const WARN_ICON = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
const CHECK_ICON = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m8 12 3 3 5-6"/></svg>`;

/** Which designs an issue is about, by file name: "Logo.png (3 st)". */
function namesFor(issue: SheetIssue, images: EditorImage[]): string[] {
  const count = new Map<string, number>();
  for (const id of issue.imageIds) {
    const img = images.find((i) => i.id === id);
    if (!img) continue;
    count.set(img.filename, (count.get(img.filename) ?? 0) + 1);
  }
  return [...count].map(([name, n]) => (n > 1 ? `${name} (${n} st)` : name));
}

/**
 * Last stop before the cart.
 *
 * Designs on top of each other or off the film print wrong, and an "order
 * anyway" button here was clicked through: #1024 was paid for as 1 m with
 * 2 m of logos piled onto it. Those errors only offer the fix — which
 * re-arranges and, if needed, lengthens the sheet at its real price. Low
 * resolution and touching corners are warnings the customer may accept.
 */
function IssueDialog({
  checks,
  fixing,
  fixFailed,
  onCancel,
  onFix,
  onProceed,
}: {
  checks: SheetCheck[];
  fixing: boolean;
  fixFailed: boolean;
  onCancel: () => void;
  onFix: () => void;
  onProceed: () => void;
}) {
  const hasErrors = checks.some((c) => c.issues.some((i) => i.severity === "error"));
  const several = checks.length > 1 || useEditorStore.getState().sheets.length > 1;

  return (
    <Modal
      title={hasErrors ? "Åtgärda innan du beställer" : "Innan du beställer"}
      lead={
        hasErrors
          ? "Motiv som ligger på varandra eller utanför filmen trycks fel. Vi kan ordna dem åt dig, och blir arket längre ser du det nya priset innan du lägger i varukorgen."
          : "Det här kan påverka trycket:"
      }
      icon={WARN_ICON}
      tone="warning"
      onClose={fixing ? undefined : onCancel}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {checks.flatMap((check) =>
          check.issues.map((issue, i) => {
            const names = namesFor(issue, check.images);
            const error = issue.severity === "error";
            return (
              <div key={`${check.index}-${i}`} style={{ ...D.issue, ...(error ? D.issueError : D.issueWarning) }}>
                <div style={{ fontWeight: theme.fontWeight.semibold }}>
                  {several ? `${check.name}: ` : ""}
                  {issue.message}
                </div>
                {names.length > 0 && (
                  <div style={D.issueNames}>
                    {names.slice(0, 4).join(", ")}
                    {names.length > 4 ? ` och ${names.length - 4} till` : ""}
                  </div>
                )}
              </div>
            );
          }),
        )}
      </div>
      {/* Still wrong after a fix: more than the longest sheet holds. */}
      {hasErrors && fixFailed && !fixing && (
        <p style={{ ...D.lead, margin: "12px 0 0" }}>
          Får det inte plats ens på 10 meter? Lägg en del av motiven på ett nytt ark, eller gör dem mindre.
        </p>
      )}
      <div style={D.actions}>
        <button onClick={onCancel} style={D.secondary} disabled={fixing}>
          Ändra själv
        </button>
        {hasErrors ? (
          <button onClick={onFix} style={{ ...D.primary, opacity: fixing ? 0.7 : 1 }} disabled={fixing}>
            {fixing ? "Ordnar arket…" : "Ordna arket automatiskt"}
          </button>
        ) : (
          <button onClick={onProceed} style={D.primary}>
            Fortsätt ändå
          </button>
        )}
      </div>
    </Modal>
  );
}

function previewPieces(images: EditorImage[]): PreviewPiece[] {
  return images
    .filter((img) => img.placed)
    .map((img) => {
      const box = imageBbox(img);
      return {
        url: img.bgRemovedUrl || img.thumbnailUrl,
        fixed: {
          ...box,
          rotation: img.rotation,
          unrotatedW: img.displayWidth,
          unrotatedH: img.displayHeight,
        },
      };
    });
}

function ConfirmDialog({
  jobs,
  onCancel,
  onConfirm,
}: {
  jobs: SheetJob[];
  onCancel: () => void;
  onConfirm: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const [rights, setRights] = useState(false);
  const pieces = piecesOf(jobs);
  const prices = jobs.map(jobPrice);
  const total = prices.every((p) => p !== null) ? prices.reduce<number>((a, b) => a + (b ?? 0), 0) : null;
  const several = jobs.length > 1;

  return (
    <Modal
      title="Bekräfta din beställning"
      lead={several ? `Kontrollera dina ${jobs.length} ark och lägg dem i varukorgen.` : "Kontrollera arket och lägg det i varukorgen."}
      onClose={onCancel}
      width={500}
    >
      <label style={D.fieldLabel} htmlFor="gs-order-name">
        Namn på beställningen <span style={{ color: theme.textDim, fontWeight: 400 }}>(valfritt)</span>
      </label>
      <input
        id="gs-order-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={60}
        placeholder="t.ex. Lagtröjor 2026"
        style={D.input}
      />
      <div style={D.help}>Visas på ordern{several ? " för alla ark" : ""}, så att du känner igen den.</div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 16 }}>
        {jobs.map((job, i) => (
          <SheetSummary key={job.sheet.id} job={job} price={prices[i] ?? null} title={several ? job.name : undefined} />
        ))}
      </div>

      {several && (
        <div style={D.totalRow}>
          <span>
            Totalt ({jobs.length} ark, {pieces} motiv)
          </span>
          <strong>{total !== null ? `${total} kr` : "—"}</strong>
        </div>
      )}

      <label style={D.rights}>
        <input
          type="checkbox"
          checked={rights}
          onChange={(e) => setRights(e.target.checked)}
          style={{ width: 18, height: 18, marginTop: 1, accentColor: theme.accent, flexShrink: 0 }}
        />
        <span>
          Jag bekräftar att jag har rätt att trycka motiven på {several ? "arken" : "arket"}. Logotyper och varumärken
          kräver tillstånd från ägaren.
        </span>
      </label>

      <div style={D.actions}>
        <button onClick={onCancel} style={D.secondary}>
          Avbryt
        </button>
        <button
          onClick={() => onConfirm(name.trim())}
          disabled={!rights}
          style={{ ...D.primary, ...(rights ? null : D.primaryDisabled), display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}
        >
          <span dangerouslySetInnerHTML={{ __html: CART_ICON }} style={{ display: "flex" }} />
          Lägg i varukorgen
        </button>
      </div>
      {!rights && <div style={{ ...D.help, textAlign: "center", marginTop: 8 }}>Kryssa i rutan för att fortsätta.</div>}
    </Modal>
  );
}

function SheetSummary({ job, price, title }: { job: SheetJob; price: number | null; title?: string }) {
  const pieces = useMemo(() => previewPieces(job.sheetImages), [job.sheetImages]);
  const designs = groupImages(job.sheetImages).length;
  const copies = Math.max(1, job.sheet.quantity || 1);
  return (
    <div style={D.sheetCard}>
      <div style={{ flex: 1, minWidth: 0 }}>
        {title && <div style={D.sheetTitle}>{title}</div>}
        <Row label="Arklängd" value={job.size.label} />
        {copies > 1 && <Row label="Antal ark" value={`${copies} st`} />}
        <Row label="Motiv" value={designs === job.sheetImages.length ? `${designs}` : `${designs} (${job.sheetImages.length} st)`} />
        <div style={D.rule} />
        <Row label="Pris" value={price !== null ? `${price} kr` : "—"} strong />
      </div>
      <div style={D.thumb}>
        <SheetPreview
          pieces={pieces}
          sheetWidthMm={job.size.widthMm}
          sheetHeightMm={job.size.heightMm}
          label={job.size.label}
          maxWidth={72}
          maxHeight={118}
          bare
        />
      </div>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div style={D.row}>
      <span style={{ color: theme.textMuted }}>{label}</span>
      <span style={{ fontWeight: strong ? theme.fontWeight.bold : theme.fontWeight.medium, color: strong ? theme.accent : theme.text, textAlign: "right" }}>
        {value}
      </span>
    </div>
  );
}

function ProgressDialog({
  phase,
  onRetry,
  onClose,
}: {
  phase: Extract<Phase, { kind: "adding" }>;
  onRetry: () => void;
  onClose: () => void;
}) {
  const several = phase.jobs.length > 1;
  const steps = [
    several ? "Sparar arken" : "Sparar arket",
    several ? "Förbereder tryckfilerna" : "Förbereder tryckfilen",
    "Lägger i varukorgen",
  ];
  const pct = Math.round((phase.done / phase.total) * 100);
  const failed = Boolean(phase.error);
  return (
    <Modal
      title={failed ? "Det gick inte att lägga i varukorgen" : "Lägger i varukorgen"}
      lead={failed ? undefined : several ? `Vi förbereder dina ${phase.jobs.length} ark.` : "Vi förbereder ditt ark."}
      tone={failed ? "warning" : "default"}
      icon={failed ? WARN_ICON : undefined}
      onClose={failed ? onClose : undefined}
      width={420}
    >
      {failed ? (
        <>
          <p style={{ ...D.lead, marginTop: 0 }}>{phase.error}</p>
          <div style={D.actions}>
            <button onClick={onClose} style={D.secondary}>
              Stäng
            </button>
            <button onClick={onRetry} style={D.primary}>
              Försök igen
            </button>
          </div>
        </>
      ) : (
        <>
          <ol style={D.steps}>
            {steps.map((label, i) => {
              const state = i < phase.step ? "done" : i === phase.step ? "active" : "todo";
              return (
                <li key={label} style={{ ...D.step, color: state === "done" ? theme.success : state === "active" ? theme.text : theme.textDim }}>
                  <span style={D.stepIcon}>
                    {state === "done" ? (
                      <span dangerouslySetInnerHTML={{ __html: CHECK_ICON }} style={{ display: "flex" }} />
                    ) : state === "active" ? (
                      <span style={D.spinner} />
                    ) : (
                      <span style={D.dot} />
                    )}
                  </span>
                  {label}…
                </li>
              );
            })}
          </ol>
          <div style={D.barTrack}>
            <div style={{ ...D.barFill, width: `${Math.max(6, pct)}%` }} />
          </div>
          <div style={{ ...D.help, textAlign: "center", marginTop: 6 }}>{pct} %</div>
        </>
      )}
    </Modal>
  );
}

function AddedDialog({ jobs, name }: { jobs: SheetJob[]; name: string }) {
  const several = jobs.length > 1;
  return (
    <Modal title="Tillagt i varukorgen" icon={CHECK_ICON} tone="success" width={420}>
      <div style={D.added}>
        <div style={{ fontSize: 30, lineHeight: 1, color: theme.success }}>✓</div>
        <div style={{ fontWeight: theme.fontWeight.semibold, color: theme.text }}>
          {name ? `${name} är redo för kassan` : several ? "Dina ark är redo för kassan" : "Ditt ark är redo för kassan"}
        </div>
        <div style={{ color: theme.textMuted, fontSize: theme.fontSize.bodySm }}>
          {jobs.length} ark · {piecesOf(jobs)} motiv
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, marginTop: 14, color: theme.textMuted, fontSize: theme.fontSize.bodySm }}>
        <span style={D.spinner} /> Går till varukorgen…
      </div>
    </Modal>
  );
}

const D: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "fixed",
    inset: 0,
    background: "rgba(17,17,20,0.55)",
    backdropFilter: "blur(2px)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
    zIndex: 60,
  },
  modal: {
    width: "100%",
    maxHeight: "calc(100dvh - 32px)",
    overflowY: "auto",
    background: theme.bg,
    borderRadius: 18,
    padding: "20px 22px 22px",
    boxShadow: "0 24px 80px rgba(0,0,0,0.25)",
    fontFamily: theme.fontFamily,
    color: theme.text,
  },
  head: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 },
  title: {
    margin: 0,
    fontSize: "1.0625rem",
    fontWeight: theme.fontWeight.bold,
    display: "flex",
    alignItems: "center",
    gap: 8,
    lineHeight: 1.3,
  },
  close: {
    border: "none",
    background: "transparent",
    fontSize: 24,
    lineHeight: 1,
    color: theme.textMuted,
    cursor: "pointer",
    padding: "0 2px",
  },
  lead: {
    margin: "6px 0 14px",
    fontSize: theme.fontSize.bodySm,
    color: theme.textMuted,
    lineHeight: 1.5,
  },
  issue: {
    padding: "10px 12px",
    borderRadius: 12,
    fontSize: theme.fontSize.bodySm,
    lineHeight: 1.45,
  },
  issueError: { background: "#fff4ed", border: "1px solid #fed7aa", color: "#9a3412" },
  issueWarning: { background: "#fffbeb", border: "1px solid #fde68a", color: "#92400e" },
  issueNames: { marginTop: 4, fontSize: theme.fontSize.labelMd, opacity: 0.9, wordBreak: "break-word" },
  fieldLabel: {
    display: "block",
    fontSize: theme.fontSize.labelLg,
    fontWeight: theme.fontWeight.semibold,
    marginBottom: 6,
  },
  input: {
    width: "100%",
    padding: "11px 12px",
    border: `1px solid ${theme.borderStrong}`,
    borderRadius: 10,
    fontSize: theme.fontSize.bodyMd,
    fontFamily: theme.fontFamily,
    color: theme.text,
    background: theme.bg,
    boxSizing: "border-box",
  },
  help: { fontSize: theme.fontSize.labelMd, color: theme.textMuted, marginTop: 6 },
  sheetCard: {
    display: "flex",
    gap: 14,
    alignItems: "center",
    padding: 14,
    borderRadius: 14,
    background: "#f6f6f7",
  },
  sheetTitle: { fontWeight: theme.fontWeight.semibold, marginBottom: 6, fontSize: theme.fontSize.bodySm },
  row: { display: "flex", justifyContent: "space-between", gap: 12, fontSize: theme.fontSize.bodySm, padding: "3px 0" },
  rule: { height: 1, background: theme.border, margin: "6px 0" },
  thumb: {
    flexShrink: 0,
    width: 84,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 6,
    background: "#fff",
    borderRadius: 10,
    border: `1px solid ${theme.border}`,
  },
  totalRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 10,
    padding: "12px 14px",
    borderRadius: 12,
    background: theme.accentBg,
    fontSize: theme.fontSize.bodySm,
    fontWeight: theme.fontWeight.semibold,
  },
  rights: {
    display: "flex",
    gap: 10,
    alignItems: "flex-start",
    marginTop: 16,
    fontSize: theme.fontSize.bodySm,
    lineHeight: 1.45,
    cursor: "pointer",
  },
  actions: { display: "flex", gap: 10, marginTop: 18 },
  secondary: {
    flex: "0 0 auto",
    padding: "12px 18px",
    border: `1px solid ${theme.borderStrong}`,
    borderRadius: 12,
    background: theme.bg,
    color: theme.text,
    fontSize: theme.fontSize.bodySm,
    fontFamily: theme.fontFamily,
    fontWeight: theme.fontWeight.semibold,
    cursor: "pointer",
  },
  primary: {
    flex: 1,
    padding: "12px",
    whiteSpace: "nowrap",
    border: "none",
    borderRadius: 12,
    background: theme.accent,
    color: "#fff",
    fontSize: theme.fontSize.bodySm,
    fontFamily: theme.fontFamily,
    fontWeight: theme.fontWeight.bold,
    cursor: "pointer",
  },
  primaryDisabled: { background: "#efb3b8", cursor: "not-allowed" },
  steps: { listStyle: "none", margin: "4px 0 16px", padding: 0, display: "flex", flexDirection: "column", gap: 12 },
  step: { display: "flex", alignItems: "center", gap: 10, fontSize: theme.fontSize.bodyMd, fontWeight: theme.fontWeight.medium },
  stepIcon: { width: 22, display: "flex", justifyContent: "center" },
  dot: { width: 8, height: 8, borderRadius: "50%", background: theme.border },
  spinner: {
    display: "inline-block",
    width: 16,
    height: 16,
    borderRadius: "50%",
    border: `2px solid ${theme.accent}`,
    borderTopColor: "transparent",
    animation: "gs-spin 0.8s linear infinite",
  },
  barTrack: { height: 6, borderRadius: 3, background: "#eceef1", overflow: "hidden" },
  barFill: { height: "100%", background: theme.accent, borderRadius: 3, transition: "width 0.3s ease" },
  added: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 6,
    padding: "18px 12px",
    borderRadius: 14,
    background: theme.successBg,
    border: "1px solid rgba(46,125,50,0.18)",
    textAlign: "center",
    marginTop: 8,
  },
};
