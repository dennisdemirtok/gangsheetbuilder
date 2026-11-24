/**
 * Prints what the weekday "Paket att kolla" digest would list right now,
 * without sending. Add an address to also send that mail there.
 *
 *   railway run --service gangsheetbuilder npx tsx scripts/stuck-shipments-check.ts
 *   railway run --service gangsheetbuilder npx tsx scripts/stuck-shipments-check.ts dennis@transfercraft.com
 */
import { sendStuckShipmentDigest } from "../app/lib/stuck-shipments.server";
import { sendMail, mailFrom } from "../app/lib/mailer.server";

async function main() {
  const to = process.argv.slice(2).find((a) => a.includes("@"));
  const { check, mail } = await sendStuckShipmentDigest({ dryRun: true });
  console.log(`${check.checked} checked, ${check.stuck.length} to check, ${check.errors.length} error(s)`);
  for (const e of check.errors) console.log(`  error ${e.order}: ${e.detail}`);
  if (!mail) return;
  console.log(`\nSubject: ${mail.subject}\n\n${mail.text}`);
  if (to) {
    await sendMail({ to, from: mailFrom(), subject: mail.subject, html: mail.html, text: mail.text });
    console.log(`\nSent to ${to}`);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
