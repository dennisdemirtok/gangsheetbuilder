import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  TextField,
  Button,
  InlineStack,
  FormLayout,
  Banner,
  ChoiceList,
  Divider,
  Box,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { useEffect } from "react";
import {
  DEFAULT_PRICES_SEK,
  DEFAULT_FILM_MODIFIERS,
  SHEET_SIZES,
  FILM_TYPES,
} from "../lib/constants";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  let config = await prisma.appConfig.findUnique({
    where: { shopDomain: session.shop },
  });

  if (!config) {
    config = await prisma.appConfig.create({
      data: { shopDomain: session.shop },
    });
  }

  // Get image and export counts for GDPR section
  const [imageCount, exportCount] = await Promise.all([
    prisma.gangSheetImage.count({
      where: { gangSheet: { shopDomain: session.shop } },
    }),
    prisma.gangSheetExport.count({
      where: { gangSheet: { shopDomain: session.shop } },
    }),
  ]);

  return json({ config, imageCount, exportCount });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  const priceConfig: Record<string, number> = {};
  const filmModifiers: Record<string, number> = {};

  for (const size of SHEET_SIZES) {
    const val = formData.get(`price_${size.key}`);
    if (val) priceConfig[size.key] = parseInt(String(val));
  }

  for (const film of FILM_TYPES) {
    const val = formData.get(`film_${film.key}`);
    if (val) filmModifiers[film.key] = parseFloat(String(val));
  }

  const gapSizeMm = parseInt(String(formData.get("gapSizeMm") || "3"));
  const minDpi = parseInt(String(formData.get("minDpi") || "150"));
  const maxFileSizeMb = parseInt(
    String(formData.get("maxFileSizeMb") || "50"),
  );
  const autoDeleteDays = parseInt(
    String(formData.get("autoDeleteDays") || "90"),
  );
  const exportDeleteDays = parseInt(
    String(formData.get("exportDeleteDays") || "30"),
  );

  // Parse variant mapping (JSON)
  let variantMapping = null;
  const variantMappingStr = formData.get("variantMapping") as string;
  if (variantMappingStr) {
    try {
      variantMapping = JSON.parse(variantMappingStr);
    } catch {
      // keep null
    }
  }

  await prisma.appConfig.upsert({
    where: { shopDomain: session.shop },
    create: {
      shopDomain: session.shop,
      priceConfig,
      filmModifiers,
      gapSizeMm,
      minDpi,
      maxFileSizeMb,
      autoDeleteDays,
      exportDeleteDays,
      variantMapping,
    },
    update: {
      priceConfig,
      filmModifiers,
      gapSizeMm,
      minDpi,
      maxFileSizeMb,
      autoDeleteDays,
      exportDeleteDays,
      variantMapping,
    },
  });

  return json({ success: true });
};

export default function SettingsPage() {
  const { config, imageCount, exportCount } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();
  const shopify = useAppBridge();

  const prices =
    (config.priceConfig as Record<string, number>) || DEFAULT_PRICES_SEK;
  const modifiers =
    (config.filmModifiers as Record<string, number>) || DEFAULT_FILM_MODIFIERS;

  const isSaving = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data?.success) {
      shopify.toast.show("Inställningar sparade");
    }
  }, [fetcher.data, shopify]);

  return (
    <Page>
      <TitleBar title="Inställningar" />
      <fetcher.Form method="post">
        <BlockStack gap="500">
          {/* Prices */}
          <Layout>
            <Layout.AnnotatedSection
              title="Priser per storlek"
              description="Grundpriser i SEK för varje arkstorlek."
            >
              <Card>
                <FormLayout>
                  {SHEET_SIZES.map((size) => (
                    <TextField
                      key={size.key}
                      label={size.label}
                      name={`price_${size.key}`}
                      type="number"
                      defaultValue={String(prices[size.key] || 0)}
                      suffix="kr"
                      autoComplete="off"
                    />
                  ))}
                </FormLayout>
              </Card>
            </Layout.AnnotatedSection>

            {/* Film Modifiers */}
            <Layout.AnnotatedSection
              title="Filmtyps-multiplikatorer"
              description="Prismultiplikator per filmtyp. 1.0 = grundpris, 1.5 = 50% mer."
            >
              <Card>
                <FormLayout>
                  {FILM_TYPES.map((film) => (
                    <TextField
                      key={film.key}
                      label={film.label}
                      name={`film_${film.key}`}
                      type="number"
                      step="0.1"
                      defaultValue={String(modifiers[film.key] || 1.0)}
                      suffix="x"
                      autoComplete="off"
                    />
                  ))}
                </FormLayout>
              </Card>
            </Layout.AnnotatedSection>

            {/* Resolution & Quality */}
            <Layout.AnnotatedSection
              title="Upplösning & kvalitet"
              description="Inställningar för DPI-kontroll och exportkvalitet. Exportfilen blir alltid 300 DPI PNG."
            >
              <Card>
                <FormLayout>
                  <TextField
                    label="Minsta DPI-varning"
                    name="minDpi"
                    type="number"
                    defaultValue={String(config.minDpi)}
                    helpText="Bilder under denna DPI visas med gul varning i editorn"
                    suffix="DPI"
                    autoComplete="off"
                  />
                  <Banner tone="info">
                    <Text as="p" variant="bodySm">
                      Exportformatet är alltid transparent PNG med 300 DPI —
                      redo för RIP-mjukvaran. Bilder med vit bakgrund varnas
                      automatiskt.
                    </Text>
                  </Banner>
                </FormLayout>
              </Card>
            </Layout.AnnotatedSection>

            {/* Technical Settings */}
            <Layout.AnnotatedSection
              title="Tekniska inställningar"
              description="Konfiguration för bildbehandling."
            >
              <Card>
                <FormLayout>
                  <TextField
                    label="Gap mellan designs"
                    name="gapSizeMm"
                    type="number"
                    defaultValue={String(config.gapSizeMm)}
                    suffix="mm"
                    helpText="Avstånd mellan designs vid auto-placering"
                    autoComplete="off"
                  />
                  <TextField
                    label="Max filstorlek"
                    name="maxFileSizeMb"
                    type="number"
                    defaultValue={String(config.maxFileSizeMb)}
                    suffix="MB"
                    autoComplete="off"
                  />
                </FormLayout>
              </Card>
            </Layout.AnnotatedSection>

            {/* Variant Mapping */}
            <Layout.AnnotatedSection
              title="Shopify-produktkoppling"
              description="Mappa arkstorlekar och filmtyper till Shopify-produktvarianter. JSON-format."
            >
              <Card>
                <FormLayout>
                  <TextField
                    label="Variant-mapping (JSON)"
                    name="variantMapping"
                    multiline={6}
                    defaultValue={
                      config.variantMapping
                        ? JSON.stringify(config.variantMapping, null, 2)
                        : '{\n  "60x120_standard": "VARIANT_ID_HERE",\n  "60x120_glitter": "VARIANT_ID_HERE"\n}'
                    }
                    helpText='Format: {"storlek_filmtyp": "shopify_variant_id"}'
                    autoComplete="off"
                    monospaced
                  />
                </FormLayout>
              </Card>
            </Layout.AnnotatedSection>

            {/* GDPR */}
            <Layout.AnnotatedSection
              title="GDPR & datalagring"
              description={`Automatisk radering av kunddata. Just nu: ${imageCount} bilder, ${exportCount} exportfiler.`}
            >
              <Card>
                <FormLayout>
                  <TextField
                    label="Radera kundbilder efter"
                    name="autoDeleteDays"
                    type="number"
                    defaultValue={String(config.autoDeleteDays)}
                    suffix="dagar"
                    autoComplete="off"
                  />
                  <TextField
                    label="Radera exportfiler efter"
                    name="exportDeleteDays"
                    type="number"
                    defaultValue={String(config.exportDeleteDays)}
                    suffix="dagar"
                    autoComplete="off"
                  />
                </FormLayout>
              </Card>
            </Layout.AnnotatedSection>
          </Layout>

          <InlineStack align="end">
            <Button variant="primary" submit loading={isSaving}>
              Spara inställningar
            </Button>
          </InlineStack>
        </BlockStack>
      </fetcher.Form>
    </Page>
  );
}
