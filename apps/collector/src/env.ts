import type { SchedulerDO } from "./scheduler";

export interface Env {
  DB: D1Database;
  ARCHIVE: R2Bucket;
  SCHEDULER: DurableObjectNamespace<SchedulerDO>;

  // Vars

  // Secrets (wrangler secret put …)
  ASC_ISSUER_ID: string;
  ASC_KEY_ID: string;
  ASC_PRIVATE_KEY: string; // .p8 PEM contents
  ADS_CLIENT_ID: string;
  ADS_TEAM_ID: string;
  ADS_KEY_ID: string;
  ADS_PRIVATE_KEY: string; // .p8 PEM contents
  /** Gates POST /admin/run. Unset means the route does not exist. */
  ADMIN_TOKEN?: string;
}

export const COLLECTOR_VERSION = "0.2.0";
