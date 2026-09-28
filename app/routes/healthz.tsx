import { json } from "@remix-run/node";
import prisma from "../db.server";
import { verifyMail } from "../lib/mailer.server";

// Logging in to Gmail on every health check would be wasteful; once per 10 min.
let mailCheck: { at: number; ok: boolean } | null = null;
async function mailOk(): Promise<boolean> {
  if (!mailCheck || Date.now() - mailCheck.at > 10 * 60 * 1000) {
    mailCheck = { at: Date.now(), ok: (await verifyMail()).ok };
  }
  return mailCheck.ok;
}

/**
 * Deploy check.
 *
 * Railway rebuilds on a push to main and runs `prisma migrate deploy` before
 * the server starts, but nothing outside the dashboard could confirm which
 * commit is actually serving traffic or whether a migration landed. That
 * matters when a storefront release has to wait for a backend column.
 *
 * Reports the running commit and whether the schema additions the theme
 * extension depends on exist. No shop or customer data is exposed.
 */
export const loader = async () => {
  let db = false;
  let placementsJson = false;

  try {
    const rows = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'gangsheet_gang_sheet_image'
        AND column_name = 'placements_json'
    `;
    db = true;
    placementsJson = rows.length > 0;
  } catch (error) {
    console.error("[healthz] database check failed:", error);
  }

  const commit =
    process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT_SHA ?? null;

  return json(
    {
      ok: db,
      commit: commit ? commit.slice(0, 7) : null,
      migrations: { placementsJson },
      mail: await mailOk(),
    },
    {
      status: db ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
};
