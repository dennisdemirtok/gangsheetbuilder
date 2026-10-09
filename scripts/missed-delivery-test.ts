/**
 * The missed-delivery email with made-up data, sent to one address — to see
 * it in a real inbox. Add --check to also print what the hourly sweep would
 * do for the shipped orders right now, without sending or saving anything.
 *
 *   railway run --service gangsheetbuilder npx tsx scripts/missed-delivery-test.ts dennis@transfercraft.com
 *   railway run --service gangsheetbuilder npx tsx scripts/missed-delivery-test.ts --check
 */
import { missedDeliveryMail, sweepMissedDeliveries } from "../app/lib/missed-delivery.server";
import { sendMail, mailFrom } from "../app/lib/mailer.server";

async function main() {
  const args = process.argv.slice(2);
  const to = args.find((a) => a.includes("@"));

  if (args.includes("--check")) {
    for (const r of await sweepMissedDeliveries({ dryRun: true })) {
      console.log(`${r.order}: ${r.action}${r.detail ? ` (${r.detail})` : ""}`);
    }
  }

  if (to) {
    const now = new Date();
    const mail = missedDeliveryMail({
      orderName: "#1061",
      customerName: "Anna Andersson",
      attemptAt: new Date(now.getTime() - 20 * 60 * 60 * 1000),
      now,
      trackingNumber: "886212345678",
      trackingUrl: "https://www.fedex.com/fedextrack/?trknbr=886212345678",
      address: {
        name: "Anna Andersson",
        company: null,
        address1: "Storgatan 12",
        address2: null,
        zip: "123 45",
        city: "Stockholm",
        country: "Sweden",
        countryCode: "SE",
      },
    });
    await sendMail({
      to,
      from: process.env.CUSTOMER_MAIL_FROM || mailFrom(),
      replyTo: process.env.CUSTOMER_REPLY_TO || undefined,
      subject: `TEST (exempeldata): ${mail.subject}`,
      html: mail.html,
      text: mail.text,
    });
    console.log(`Test email sent to ${to}`);
  }

  if (!to && !args.includes("--check")) {
    console.error("Give an email address to send the test to, and/or --check.");
    process.exit(1);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
