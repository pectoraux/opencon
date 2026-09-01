/**
 * Configuration schema — typed, validated, fail-fast.
 *
 * Work order ref: NET-W001 §4.3 (Configuration). Uses zod for typed
 * validation with classified errors and safe development defaults.
 *
 * Required secrets are classified but in `development` a safe placeholder
 * is permitted so the skeleton can start. In `production` / `staging`,
 * a missing required secret fails startup with a classified
 * ConfigurationValidationError (AC-04).
 */

import { z } from "zod";

const AppEnvSchema = z.enum(["development", "test", "staging", "production"]);

const LogLevelSchema = z.enum(["trace", "debug", "info", "warn", "error", "fatal"]);

export const ConfigSchema = z.object({
  APP_ENV: AppEnvSchema.default("development"),
  APP_NAME: z.string().min(1).default("opencon"),
  PORT: z.coerce.number().int().min(0).max(65535).default(8787),

  // Secrets — classified. In non-development, presence is enforced at the
  // SecretProvider boundary (see src/secrets/env-provider.ts).
  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),
  OBJECT_STORAGE_BUCKET: z.string().optional(),
  // NET-W005: key for the default HMAC attestation signer/verifier
  // (src/evidence/hmac-attestation-verifier.ts). Classified secret.
  // FAIL CLOSED (architect review on PR #10): in production/staging the
  // composition root (src/bootstrap/attestation-signing.ts) REQUIRES
  // either this secret — resolved through the SecretProvider — or an
  // explicitly configured production signer/verifier adapter pair;
  // otherwise startup fails with ProviderConfigurationError. The
  // well-known dev default is permitted only in development (warned)
  // and test (silent).
  ATTESTATION_SIGNING_KEY: z.string().optional(),
  // NET-W029: the production signature algorithm selector for the
  // versioned (signed-attestation) surface. NON-SECRET configuration.
  // Default "hmac-sha256" keeps existing configured deployments
  // booting unchanged (the W005 remediation contract); "ed25519" /
  // "ecdsa-p256" opt IN to the real asymmetric production algorithms
  // (key material then resolves ONLY through the SecretProvider via
  // ATTESTATION_SIGNING_ED25519_PRIVATE_KEY /
  // ATTESTATION_SIGNING_ECDSA_PRIVATE_KEY — fail closed when absent).
  ATTESTATION_SIGNING_ALGORITHM: z
    .enum(["ed25519", "ecdsa-p256", "hmac-sha256"])
    .default("hmac-sha256"),
  // NET-W029: asymmetric production signing key material (PKCS#8 PEM),
  // resolved ONLY through the SecretProvider at composition time —
  // never logged, persisted, or echoed into audit/error payloads
  // (PRIV-002/PRIV-003; the secret scan stays clean). Presence is
  // REQUIRED only when the matching algorithm is selected in
  // production/staging (fail closed); absent otherwise.
  ATTESTATION_SIGNING_ED25519_PRIVATE_KEY: z.string().optional(),
  ATTESTATION_SIGNING_ECDSA_PRIVATE_KEY: z.string().optional(),
  // NET-W022: provider verification secrets (HMAC-SHA256 keys) for
  // the reference attribution adapters. Classified secrets, resolved
  // ONLY through the SecretProvider at composition time. When
  // present, the respective reference adapter (browser-attribution /
  // ios-attribution) is auto-wired into the measurement provider
  // registry; when absent, pushed reports for that provider fail
  // closed (unverifiable integrity). Never logged, persisted, or
  // echoed into audit/error payloads (PRIV-002).
  MEASUREMENT_BROWSER_ATTRIBUTION_KEY: z.string().optional(),
  MEASUREMENT_IOS_ATTRIBUTION_KEY: z.string().optional(),
  // NET-W023: provider verification secret (HMAC-SHA256 key) for the
  // reference delivery-notice measurement adapter (the sanctioned
  // measurement routing path: delivery facts flow through the W022
  // push-report ingestion chain into /outcomes). Classified secret,
  // resolved ONLY through the SecretProvider at composition time.
  // When present, the delivery-notice adapter is auto-wired into the
  // measurement provider registry; when absent, pushed notices fail
  // closed (unverifiable integrity). Never logged, persisted, or
  // echoed into audit/error payloads (PRIV-002).
  MEASUREMENT_OPENRTB_DELIVERY_KEY: z.string().optional(),
  // NET-W023 PR #47 remediation: the seller-authorization trust
  // channel key (HMAC-SHA256) for supply-chain verification. When
  // present, the OpenRTB ingress authenticates seller-authorization
  // trust envelopes (ads.txt / app-ads.txt / sellers.json submissions
  // signed by the trusted supply-chain collector channel); when
  // absent, NO supply chain can be `verified` (fail closed —
  // unauthenticated authorization evidence is never promoted to
  // authorization). Classified secret, resolved ONLY through the
  // SecretProvider at composition time. Never logged, persisted, or
  // echoed into audit/error payloads (PRIV-002).
  SELLER_AUTHORIZATION_TRUST_KEY: z.string().optional(),
  // NET-W030: per-provider external-settlement trust keys (HMAC-SHA256)
  // for the external settlement adapter channel (ADAPTER-008; issue
  // #61). Classified secrets, resolved ONLY through the SecretProvider
  // at composition time. When present, the respective provider's
  // submissions are authenticated; when absent, ingestion for that
  // provider fails closed (`unauthenticated` — nothing is ever
  // recorded; the W022 "no secret → fail closed" wiring rule). The
  // map is closed over the frozen provider vocabulary. Never logged,
  // persisted, or echoed into audit/error payloads (PRIV-002).
  EXTERNAL_SETTLEMENT_REFERENCE_TRUST_KEY: z.string().optional(),

  // Observability
  LOG_LEVEL: LogLevelSchema.default("info"),
  LOG_PRETTY: z
    .union([z.string(), z.boolean()])
    .transform((v) => v === true || v === "true")
    .default(true),
});

export type RawConfig = z.infer<typeof ConfigSchema>;

export interface FieldClassification {
  readonly key: string;
  readonly classification: "required" | "optional" | "secret";
  readonly required: boolean;
}

export const CONFIG_FIELD_CLASSIFICATIONS: readonly FieldClassification[] = [
  { key: "APP_ENV", classification: "required", required: true },
  { key: "APP_NAME", classification: "optional", required: false },
  { key: "PORT", classification: "optional", required: false },
  { key: "DATABASE_URL", classification: "secret", required: false },
  { key: "REDIS_URL", classification: "secret", required: false },
  { key: "OBJECT_STORAGE_BUCKET", classification: "secret", required: false },
  { key: "ATTESTATION_SIGNING_KEY", classification: "secret", required: false },
  // NET-W029: the algorithm selector is NON-SECRET (a vocabulary
  // choice, not key material); the private-key PEMs are classified
  // secrets resolved only through the SecretProvider.
  { key: "ATTESTATION_SIGNING_ALGORITHM", classification: "optional", required: false },
  { key: "ATTESTATION_SIGNING_ED25519_PRIVATE_KEY", classification: "secret", required: false },
  { key: "ATTESTATION_SIGNING_ECDSA_PRIVATE_KEY", classification: "secret", required: false },
  { key: "MEASUREMENT_BROWSER_ATTRIBUTION_KEY", classification: "secret", required: false },
  { key: "MEASUREMENT_IOS_ATTRIBUTION_KEY", classification: "secret", required: false },
  { key: "MEASUREMENT_OPENRTB_DELIVERY_KEY", classification: "secret", required: false },
  { key: "SELLER_AUTHORIZATION_TRUST_KEY", classification: "secret", required: false },
  { key: "EXTERNAL_SETTLEMENT_REFERENCE_TRUST_KEY", classification: "secret", required: false },
  { key: "LOG_LEVEL", classification: "optional", required: false },
  { key: "LOG_PRETTY", classification: "optional", required: false },
] as const;

/** Fields that are required (non-optional) in non-development environments. */
export const REQUIRED_IN_PRODUCTION: readonly string[] = [
  "DATABASE_URL",
  "REDIS_URL",
  "OBJECT_STORAGE_BUCKET",
] as const;
