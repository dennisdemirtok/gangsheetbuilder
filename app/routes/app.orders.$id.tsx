import { useEffect, useState } from "react";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useFetcher, useRevalidator } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  Badge,
  Button,
  InlineStack,
  Box,
  TextField,
  DataTable,
  Banner,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  getPresignedAttachmentUrl,
  getPresignedDownloadUrl,
} from "../lib/r2.server";
import {
  formatDateTime,
  orderLabel,
  printFileName,
  statusInfo,
} from "../lib/order-status";
import { withOrderDetails } from "../lib/order-details.server";
import { jobSize, printLabel, type LineProperty } from "../lib/print-jobs";
import { orderStatusOf } from "../lib/order-list.server";
import { isVectorFormat, storeJobFile } from "../lib/job-file.server";
import { saveBlob } from "../lib/save-file";
import { saveUrl } from "../lib/save-file";
import {
  BWS_SERVICES,
  getPickupAddress,
  isBwsTestEnvironment,
  missingPickupConfig,
  PACKAGE_CM,
  PICKUP_TIME,
  isSimulationEnabled,
  SIMULATED_PREFIX,
} from "../lib/bws-shipping.server";
import {
  bookOrderShipment,
  sendTrackingToCustomer,
  summarizeOrderShipment,
} from "../lib/order-shipment.server";
import { BwsShippingCard } from "../components/BwsShippingCard";
import { missingMailConfig } from "../lib/mailer.server";
import { sendOrderToPrintShop } from "../lib/print-shop-email.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);

  const found = await prisma.gangSheet.findUnique({ where: { id: params.id } });
  if (!found || found.shopDomain !== session.shop) {
    throw new Response("Not found", { status: 404 });
  }

  /*
   * The page is the whole Shopify order. Every printed line is its own job
   * in the database, and the page used to show just one of them: an order
   * with four cut motifs meant four pages to go through.
   */
  const jobs = await prisma.gangSheet.findMany({
    where: found.shopifyOrderId
      ? { shopDomain: session.shop, shopifyOrderId: found.shopifyOrderId }
      : { id: found.id },
    orderBy: { createdAt: "asc" },
    include: {
      exports: { orderBy: { createdAt: "desc" }, take: 1 },
      images: { select: { dpiX: true, originalFilename: true }, take: 1 },
      _count: { select: { images: true } },
    },
  });

  const [[gangSheet], notes, previews, summary] = await Promise.all([
    withOrderDetails(admin, session.shop, [found]),
    prisma.gangSheetNote.findMany({
      where: { gangSheetId: { in: jobs.map((j) => j.id) } },
      orderBy: { createdAt: "desc" },
    }),
    Promise.all(jobs.map((j) => (j.previewUrl ? getPresignedDownloadUrl(j.previewUrl) : null))),
    found.shopifyOrderId ? summarizeOrderShipment(session.shop, found.shopifyOrderId) : null,
  ]);

  const orderStatus = orderStatusOf(jobs);

  const shipping = summary
    ? {
        summary,
        pickup: getPickupAddress(),
        pickupFrom: PICKUP_TIME,
        packageCm: { ...PACKAGE_CM },
        missingConfig: missingPickupConfig(),
        services: BWS_SERVICES,
        printShop: {
          defaultTo: process.env.PRINT_SHOP_EMAIL || "biuro@fancywork.pl",
          missingMail: missingMailConfig(),
          customerEmail:
            ((gangSheet.shippingAddress as { email?: string | null } | null)?.email) || null,
        },
        isTest: isBwsTestEnvironment(),
        simulation: isSimulationEnabled(),
        simulated: Boolean(gangSheet.bwsBookingId?.startsWith(SIMULATED_PREFIX)),
      }
    : null;

  return json({
    gangSheet: { ...gangSheet, status: orderStatus, notes },
    orderStatus,
    orderedAt: formatDateTime(gangSheet.createdAt),
    hasLabel: Boolean(gangSheet.shippingLabelKey),
    shipping,
    jobs: jobs.map((job, i) => {
      const file = job.exports[0];
      const vector = job.kind === "cut" && isVectorFormat(file?.format);
      const dpi = job.kind === "cut" && !vector ? job.images[0]?.dpiX ?? null : null;
      return {
        id: job.id,
        label: printLabel(job),
        cut: job.kind === "cut",
        size: jobSize(job),
        status: job.status,
        filmType: job.filmType,
        designs: job._count.images,
        dpi,
        props: ((job.lineProperties as LineProperty[] | null) || []).filter(
          (p) => !/bredd|höjd|hojd|width|height/i.test(p.name),
        ),
        previewUrl: previews[i],
        hasFile: Boolean(file),
        vector,
        cutJob: job.kind === "cut",
        filename: job.kind === "cut" ? job.images[0]?.originalFilename ?? null : null,
        missingFile: job.kind === "cut" && !job.sourceFileUrl,
        fileMeta: file
          ? `${file.format.toUpperCase()}${file.fileSizeBytes ? ` ${(file.fileSizeBytes / 1024 / 1024).toFixed(1)} MB` : ""}`
          : null,
      };
    }),
  });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const action = formData.get("action") as string;

  const gangSheet = await prisma.gangSheet.findUnique({
    where: { id: params.id },
  });

  if (!gangSheet || gangSheet.shopDomain !== session.shop) {
    return json({ error: "Not found" }, { status: 404 });
  }

  if (action === "download") {
    /*
     * The link is made at click time rather than on page load: a presigned
     * URL rendered into the page expired after an hour, and a print shop
     * leaves an order open far longer than that.
     */
    if (formData.get("kind") === "label") {
      if (!gangSheet.shippingLabelKey) {
        return json({ error: "No label" }, { status: 404 });
      }
      const ext = gangSheet.shippingLabelKey.split(".").pop() || "pdf";
      const name = `${orderLabel(gangSheet).replace(/^#/, "")}_label.${ext}`;
      return json({
        downloadUrl: await getPresignedAttachmentUrl(gangSheet.shippingLabelKey, name),
      });
    }

    // Any job of this order; the page lists them all.
    const jobId = String(formData.get("jobId") || gangSheet.id);
    const job = await prisma.gangSheet.findFirst({
      where: {
        id: jobId,
        shopDomain: session.shop,
        ...(gangSheet.shopifyOrderId ? { shopifyOrderId: gangSheet.shopifyOrderId } : { id: gangSheet.id }),
      },
    });
    const file = job
      ? await prisma.gangSheetExport.findFirst({
          where: { gangSheetId: job.id },
          orderBy: { createdAt: "desc" },
        })
      : null;
    if (!job || !file) return json({ error: "No print file yet" }, { status: 404 });

    // Downloading is the step itself — the shop should not have to report it.
    if (job.status === "exported") {
      await prisma.gangSheet.update({ where: { id: job.id }, data: { status: "downloaded" } });
    }
    return json({
      downloadUrl: await getPresignedAttachmentUrl(file.url, printFileName(job, file.format)),
    });
  }

  if (action === "replace_file") {
    /*
     * Swap a customer's file for a corrected one before it goes to the print
     * shop — e.g. a logo that came in as an unusable EPS. The old file stays
     * in storage; a note on the order records the swap.
     */
    const jobId = String(formData.get("jobId") || "");
    const job = await prisma.gangSheet.findFirst({
      where: {
        id: jobId,
        shopDomain: session.shop,
        ...(gangSheet.shopifyOrderId ? { shopifyOrderId: gangSheet.shopifyOrderId } : { id: gangSheet.id }),
      },
      include: { images: { select: { originalFilename: true }, take: 1 } },
    });
    const upload = formData.get("file");
    if (!job) return json({ errors: ["Print job not found."] }, { status: 404 });
    if (!(upload instanceof Blob) || upload.size === 0) {
      return json({ errors: ["Choose a file to upload."] });
    }
    if (upload.size > 150 * 1024 * 1024) {
      return json({ errors: ["The file is larger than 150 MB."] });
    }
    const name = (upload as File).name || "motif";
    const result = await storeJobFile({
      jobId: job.id,
      buffer: Buffer.from(await upload.arrayBuffer()),
      filename: name,
      contentType: upload.type,
    });
    await prisma.gangSheetNote.create({
      data: {
        gangSheetId: job.id,
        author: session.shop,
        body: `File replaced: ${name} (was ${job.images[0]?.originalFilename ?? "no file"})`,
      },
    });
    return json({
      replaced: true,
      notice: `${name} uploaded${result.vector ? " · vector" : result.dpi ? ` · ${result.dpi} DPI at print size` : ""}${result.hasPreview ? "" : " · no preview for this format"}`,
    });
  }

  // Status buttons act on the whole order: every job is printed together.
  const wholeOrder = gangSheet.shopifyOrderId
    ? { shopDomain: session.shop, shopifyOrderId: gangSheet.shopifyOrderId }
    : { id: gangSheet.id };

  if (action === "mark_printed") {
    await prisma.gangSheet.updateMany({
      where: { ...wholeOrder, status: { not: "shipped" } },
      data: { status: "printed" },
    });
  } else if (action === "mark_shipped") {
    const tracking = String(formData.get("trackingNumber") || "").trim();
    await prisma.gangSheet.updateMany({
      where: wholeOrder,
      data: {
        status: "shipped",
        shippedAt: new Date(),
        trackingNumber: tracking || null,
      },
    });
  } else if (action === "book_bws") {
    if (!gangSheet.shopifyOrderId) {
      return json({ errors: ["This sheet is not part of an order."] }, { status: 400 });
    }
    const weight = parseFloat(String(formData.get("weightKg") || ""));
    const pickupDate = String(formData.get("pickupDate") || "");
    const service = String(formData.get("service") || "").trim();
    const result = await bookOrderShipment({
      shopDomain: session.shop,
      shopifyOrderId: gangSheet.shopifyOrderId,
      pickupDate: /^\d{4}-\d{2}-\d{2}$/.test(pickupDate) ? pickupDate : undefined,
      weightKg: weight > 0 && weight <= 30 ? weight : undefined,
      service: BWS_SERVICES.some((s) => s.code === service) ? service : undefined,
    });
    return json(result.ok ? { success: true } : { errors: result.errors });
  } else if (action === "send_print_shop") {
    if (!gangSheet.shopifyOrderId) {
      return json({ errors: ["This sheet is not part of an order."] }, { status: 400 });
    }
    const to = String(formData.get("to") || "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      return json({ errors: ["Enter a valid email address for the print shop."] });
    }
    // Book first when asked, so the label goes in the same email.
    if (formData.get("book") === "1" && gangSheet.shippingStatus !== "booked") {
      const weight = parseFloat(String(formData.get("weightKg") || ""));
      const pickupDate = String(formData.get("pickupDate") || "");
      const service = String(formData.get("service") || "").trim();
      const booking = await bookOrderShipment({
        shopDomain: session.shop,
        shopifyOrderId: gangSheet.shopifyOrderId,
        pickupDate: /^\d{4}-\d{2}-\d{2}$/.test(pickupDate) ? pickupDate : undefined,
        weightKg: weight > 0 && weight <= 30 ? weight : undefined,
        service: BWS_SERVICES.some((s) => s.code === service) ? service : undefined,
      });
      if (!booking.ok) {
        return json({ errors: ["BWS booking failed, nothing was sent.", ...booking.errors] });
      }
    }
    const sent = await sendOrderToPrintShop({
      shopDomain: session.shop,
      shopifyOrderId: gangSheet.shopifyOrderId,
      to,
      message: String(formData.get("message") || ""),
      notifyCustomer: formData.get("notifyCustomer") === "1",
    });
    if (!sent.ok) return json({ errors: sent.errors });
    return json({
      success: true,
      errors: sent.errors,
      notice: `Sent to ${to}${sent.attachedFiles ? " with the files attached" : " with download links"}${sent.customerNotified ? " · customer told production has started" : ""}.`,
    });
  } else if (action === "send_tracking") {
    if (!gangSheet.shopifyOrderId) {
      return json({ errors: ["This sheet is not part of an order."] }, { status: 400 });
    }
    const result = await sendTrackingToCustomer(session.shop, gangSheet.shopifyOrderId);
    return json(result.ok ? { success: true } : { errors: [result.error] });
  } else if (action === "add_note") {
    const body = String(formData.get("body") || "").trim();
    if (body) {
      await prisma.gangSheetNote.create({
        data: {
          gangSheetId: params.id!,
          author: session.shop,
          body: body.slice(0, 2000),
        },
      });
    }
  }

  return json({ success: true });
};

interface ShippingAddress {
  name?: string | null;
  company?: string | null;
  address1?: string | null;
  address2?: string | null;
  zip?: string | null;
  city?: string | null;
  country?: string | null;
  phone?: string | null;
  email?: string | null;
}

export default function OrderDetailPage() {
  const { gangSheet, orderStatus, orderedAt, hasLabel, shipping, jobs } =
    useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const address = (gangSheet.shippingAddress as ShippingAddress | null) || null;
  const status = statusInfo(orderStatus);
  const hasFiles = jobs.some((j) => j.hasFile);
  const missing = jobs.filter((j) => j.missingFile).length;
  const lowRes = jobs.filter((j) => j.dpi != null && j.dpi < 200).length;

  const nextStep =
    orderStatus === "pending"
      ? "Paid. The files are being prepared."
      : orderStatus === "exported"
        ? missing > 0
          ? `${missing} of the print jobs has no file. Contact the customer before printing.`
          : `Send the order to the print shop (right), or download ${jobs.length > 1 ? "all files" : "the file"} and print.`
        : status.hint;

  // Separate fetchers, so downloading does not spin the status buttons.
  const statusFetcher = useFetcher();
  const noteFetcher = useFetcher<{ success?: boolean }>();
  const downloadFetcher = useFetcher<{ downloadUrl?: string; error?: string }>();
  const [downloading, setDownloading] = useState<string | null>(null);
  const [zipping, setZipping] = useState(false);
  const [note, setNote] = useState("");
  const revalidator = useRevalidator();

  const download = (kind: "file" | "label", jobId?: string) => {
    setDownloading(jobId ?? kind);
    downloadFetcher.submit(
      { action: "download", kind, ...(jobId ? { jobId } : {}) },
      { method: "post" },
    );
  };

  /** Every file of the order in one ZIP, like the bulk download in the list. */
  const downloadAll = async () => {
    if (jobs.length === 1) return download("file", jobs[0].id);
    setZipping(true);
    try {
      const res = await fetch(`/app/orders/download?orders=${gangSheet.shopifyOrderId}`);
      if (!res.ok) throw new Error(await res.text());
      saveBlob(await res.blob(), `${orderLabel(gangSheet).replace(/^#/, "")}_print-files.zip`);
      revalidator.revalidate();
    } catch (err) {
      console.error(err);
      shopify.toast.show("Could not download the files", { isError: true });
    } finally {
      setZipping(false);
    }
  };

  useEffect(() => {
    if (downloadFetcher.state !== "idle" || !downloadFetcher.data) return;
    if (downloadFetcher.data.downloadUrl) {
      saveUrl(downloadFetcher.data.downloadUrl);
    } else if (downloadFetcher.data.error) {
      shopify.toast.show(downloadFetcher.data.error, { isError: true });
    }
    setDownloading(null);
  }, [downloadFetcher.state, downloadFetcher.data, shopify]);

  useEffect(() => {
    if (noteFetcher.state === "idle" && noteFetcher.data?.success) setNote("");
  }, [noteFetcher.state, noteFetcher.data]);

  // While files are prepared, check back so the page moves on by itself.
  useEffect(() => {
    if (orderStatus !== "pending") return;
    const t = setInterval(() => revalidator.revalidate(), 10_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderStatus]);

  const statusBusy = statusFetcher.state !== "idle";
  const downloadAllLabel = jobs.length > 1 ? `Download all files (${jobs.length})` : "Download file";

  return (
    <Page
      backAction={{ content: "Orders", url: "/app/orders" }}
      title={orderLabel(gangSheet)}
      titleMetadata={<Badge tone={status.tone}>{status.label}</Badge>}
      subtitle={[gangSheet.customerName, `Ordered ${orderedAt}`].filter(Boolean).join(" · ")}
      secondaryActions={
        gangSheet.shopifyOrderId
          ? [{ content: "Open in Shopify", url: `shopify://admin/orders/${gangSheet.shopifyOrderId}` }]
          : undefined
      }
    >
      <TitleBar title={orderLabel(gangSheet)} />
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {/* The single thing to do next, for the whole order. */}
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Next step
                </Text>
                <Text as="p" variant="bodyMd">
                  {nextStep}
                </Text>
                {lowRes > 0 && (
                  <Banner tone="warning">
                    {`${lowRes} motif${lowRes > 1 ? "s have" : " has"} under 200 DPI at the ordered size and may print blurry.`}
                  </Banner>
                )}

                {(orderStatus === "exported" || orderStatus === "downloaded") && (
                  <InlineStack gap="200">
                    {hasFiles && (
                      <Button
                        variant={orderStatus === "exported" ? "primary" : undefined}
                        onClick={downloadAll}
                        loading={zipping || (jobs.length === 1 && downloading === jobs[0].id)}
                      >
                        {orderStatus === "downloaded" ? "Download again" : downloadAllLabel}
                      </Button>
                    )}
                    <statusFetcher.Form method="post">
                      <input type="hidden" name="action" value="mark_printed" />
                      <Button submit variant={orderStatus === "downloaded" ? "primary" : undefined} loading={statusBusy}>
                        Mark as printed
                      </Button>
                    </statusFetcher.Form>
                  </InlineStack>
                )}

                {orderStatus === "printed" && (
                  <statusFetcher.Form method="post">
                    <input type="hidden" name="action" value="mark_shipped" />
                    <BlockStack gap="200">
                      <TextField
                        label="Tracking number"
                        name="trackingNumber"
                        autoComplete="off"
                        helpText="Not needed if the shipment was booked with BWS."
                      />
                      <InlineStack>
                        <Button submit variant="primary" loading={statusBusy}>
                          Mark as shipped
                        </Button>
                      </InlineStack>
                    </BlockStack>
                  </statusFetcher.Form>
                )}

                {orderStatus === "shipped" && (
                  <BlockStack gap="100">
                    {gangSheet.shippedAt && (
                      <Text as="p" variant="bodySm" tone="subdued">
                        Shipped {formatDateTime(gangSheet.shippedAt)}
                      </Text>
                    )}
                    {gangSheet.trackingNumber && (
                      <Text as="p" variant="bodySm">
                        Tracking: {gangSheet.trackingNumber}
                      </Text>
                    )}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>

            {/* Every print job of the order, each with its file. */}
            <Card padding="0">
              <Box padding="400" paddingBlockEnd="200">
                <Text as="h2" variant="headingMd">
                  {jobs.length > 1 ? `Print jobs (${jobs.length})` : "Print job"}
                </Text>
              </Box>
              {jobs.map((job) => (
                <Box
                  key={job.id}
                  padding="400"
                  borderBlockStartWidth="025"
                  borderColor="border-secondary"
                >
                  <InlineStack gap="400" wrap={false} blockAlign="start">
                    <div
                      style={{
                        width: 96,
                        height: 96,
                        flexShrink: 0,
                        borderRadius: 8,
                        border: "1px solid #e1e3e5",
                        // Mid-grey checks: white logos vanish on a white one.
                        background: "repeating-conic-gradient(#9e9e9e 0% 25%, #bdbdbd 0% 50%) 50%/12px 12px",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        overflow: "hidden",
                      }}
                    >
                      {job.previewUrl ? (
                        <img
                          src={job.previewUrl}
                          alt=""
                          style={{ maxWidth: "100%", maxHeight: "100%", display: "block" }}
                        />
                      ) : (
                        <Text as="span" variant="bodyXs" tone="subdued">
                          {job.status === "pending" ? "Preparing" : "No preview"}
                        </Text>
                      )}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <BlockStack gap="100">
                        <InlineStack gap="200" blockAlign="center">
                          <Badge tone={job.cut ? "info" : undefined}>{job.label}</Badge>
                          {job.filmType !== "standard" && <Badge>{job.filmType}</Badge>}
                        </InlineStack>
                        <Text as="p" variant="bodyMd" fontWeight="semibold">
                          {job.size}
                        </Text>
                        <Text as="p" variant="bodySm" tone="subdued">
                          {[
                            job.cut ? "Print and cut out each copy" : `Print as is · ${job.designs} design${job.designs === 1 ? "" : "s"}`,
                            job.vector ? "Vector file" : job.dpi != null ? `${job.dpi} DPI at print size` : null,
                            job.filename,
                            job.fileMeta,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </Text>
                        {job.dpi != null && job.dpi < 200 && (
                          <Text as="p" variant="bodySm" tone="caution">
                            Low resolution for this size.
                          </Text>
                        )}
                        {job.missingFile && (
                          <Text as="p" variant="bodySm" tone="critical">
                            The customer did not upload a file.
                          </Text>
                        )}
                        {job.props.map((p) => (
                          <Text as="p" variant="bodySm" key={p.name}>
                            <Text as="span" tone="subdued">{p.name}: </Text>
                            {p.value}
                          </Text>
                        ))}
                      </BlockStack>
                    </div>
                    <BlockStack gap="200" inlineAlign="end">
                      {job.hasFile && (
                        <Button onClick={() => download("file", job.id)} loading={downloading === job.id}>
                          Download
                        </Button>
                      )}
                      {job.cutJob && <ReplaceFileButton jobId={job.id} />}
                    </BlockStack>
                  </InlineStack>
                </Box>
              ))}
            </Card>
          </BlockStack>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  Ship to
                </Text>
                {address ? (
                  <BlockStack gap="050">
                    <Text as="p" variant="bodyMd" fontWeight="semibold">
                      {address.name || gangSheet.customerName || "—"}
                    </Text>
                    {address.company && <Text as="p" variant="bodyMd">{address.company}</Text>}
                    <Text as="p" variant="bodyMd">{address.address1}</Text>
                    {address.address2 && <Text as="p" variant="bodyMd">{address.address2}</Text>}
                    <Text as="p" variant="bodyMd">
                      {[address.zip, address.city].filter(Boolean).join(" ")}
                    </Text>
                    <Text as="p" variant="bodyMd">{address.country}</Text>
                    {(address.phone || address.email) && (
                      <Box paddingBlockStart="100">
                        {address.phone && (
                          <Text as="p" variant="bodySm" tone="subdued">{address.phone}</Text>
                        )}
                        {address.email && (
                          <Text as="p" variant="bodySm" tone="subdued">{address.email}</Text>
                        )}
                      </Box>
                    )}
                  </BlockStack>
                ) : (
                  <Text as="p" variant="bodySm" tone="subdued">
                    No shipping address on this order.
                  </Text>
                )}
              </BlockStack>
            </Card>

            {shipping && (
              <BwsShippingCard
                sheet={{ ...gangSheet, status: orderStatus }}
                shipping={shipping}
                hasLabel={hasLabel}
                onDownloadLabel={() => download("label")}
                downloadingLabel={downloading === "label"}
              />
            )}

            {/* Notes — somewhere for the print shop and the store to talk
                about a job without leaving the app. */}
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Notes
                </Text>
                {gangSheet.notes.length > 0 && (
                  <BlockStack gap="200">
                    {gangSheet.notes.map((n) => (
                      <Box
                        key={n.id}
                        padding="300"
                        background="bg-surface-secondary"
                        borderRadius="200"
                      >
                        <BlockStack gap="100">
                          <Text as="p" variant="bodyMd">
                            {n.body}
                          </Text>
                          <Text as="p" variant="bodyXs" tone="subdued">
                            {formatDateTime(n.createdAt)}
                          </Text>
                        </BlockStack>
                      </Box>
                    ))}
                  </BlockStack>
                )}
                <noteFetcher.Form method="post">
                  <input type="hidden" name="action" value="add_note" />
                  <BlockStack gap="200">
                    <TextField
                      label="New note"
                      labelHidden
                      name="body"
                      value={note}
                      onChange={setNote}
                      multiline={2}
                      autoComplete="off"
                      placeholder="e.g. Reprinted because of a colour issue"
                    />
                    <InlineStack>
                      <Button submit disabled={!note.trim()} loading={noteFetcher.state !== "idle"}>
                        Add note
                      </Button>
                    </InlineStack>
                  </BlockStack>
                </noteFetcher.Form>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

/**
 * Upload a corrected file for one print job. The file input is hidden; the
 * button opens it, and the upload starts as soon as a file is picked.
 */
function ReplaceFileButton({ jobId }: { jobId: string }) {
  const fetcher = useFetcher<{ replaced?: boolean; notice?: string; errors?: string[] }>();
  const shopify = useAppBridge();
  const inputId = `replace-${jobId}`;

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data.replaced) shopify.toast.show(fetcher.data.notice || "File replaced");
    else if (fetcher.data.errors) shopify.toast.show(fetcher.data.errors.join(" "), { isError: true });
  }, [fetcher.state, fetcher.data, shopify]);

  return (
    <>
      <input
        id={inputId}
        type="file"
        accept=".png,.jpg,.jpeg,.webp,.tif,.tiff,.eps,.ai,.pdf,.svg"
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          if (!file) return;
          const data = new FormData();
          data.append("action", "replace_file");
          data.append("jobId", jobId);
          data.append("file", file);
          fetcher.submit(data, { method: "post", encType: "multipart/form-data" });
          e.currentTarget.value = "";
        }}
      />
      <Button
        variant="plain"
        loading={fetcher.state !== "idle"}
        onClick={() => document.getElementById(inputId)?.click()}
      >
        Replace file
      </Button>
    </>
  );
}
