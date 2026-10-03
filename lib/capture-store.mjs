// @ts-check
// Captures waiting on this computer: one sealed payload and one small record per page saved.
//
// A payload is a retailer page's data verbatim — purchases, an address, payment fragments — so it
// is never written as it arrived. `seal` and `open` are handed in: the app passes the operating
// system's keychain-backed encryption, and the tests pass a stand-in they can see through.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * @typedef {object} CaptureRecord
 * @property {string} id
 * @property {string} site       The SageFin origin the app was showing when the page was saved.
 *   A page saved while signed in to the test site is only ever sent to the test site.
 * @property {string} retailer   An IntegrationPartner.Code.
 * @property {string} kind       A RetailCaptureKinds value.
 * @property {string} capturedAt ISO 8601, UTC: when the page was read.
 * @property {string} sha256     Of the payload as it arrived, hex.
 * @property {number} bytes      The payload's size before sealing.
 */

/**
 * @param {object} options
 * @param {string} options.dir
 * @param {(plaintext: string) => Uint8Array} options.seal
 * @param {(sealed: Uint8Array) => string} options.open
 * @param {() => Date} [options.now]
 */
export function createCaptureStore({ dir, seal, open, now = () => new Date() }) {
  mkdirSync(dir, { recursive: true });

  /** @returns {CaptureRecord[]} */
  function list() {
    /** @type {CaptureRecord[]} */
    const records = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const record = JSON.parse(readFileSync(path.join(dir, name), "utf8"));
        // A record whose payload is missing is not a capture: the write was interrupted between
        // the two files, and listing it would promise bytes that are not there.
        if (isRecord(record) && existsSync(payloadPath(record.id))) records.push(record);
      } catch {
        // An unreadable record is skipped rather than failing the whole list: one bad file must
        // not hide every capture beside it.
      }
    }
    return records.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt) || a.id.localeCompare(b.id));
  }

  /** @param {string} id */
  const payloadPath = (id) => path.join(dir, `${id}.bin`);

  /**
   * Saves a page's payload, unless this exact payload is already here.
   *
   * The key is the server's, (retailer, kind, sha256), within one site. Opening the same unchanged
   * order twice is the ordinary case, and it should leave one capture, not two.
   *
   * @param {{ site: string, retailer: string, kind: string, payload: string }} capture
   * @returns {{ added: boolean, record: CaptureRecord }}
   */
  function add({ site, retailer, kind, payload }) {
    const sha256 = createHash("sha256").update(payload).digest("hex");
    const existing = list().find(
      (r) => r.site === site && r.retailer === retailer && r.kind === kind && r.sha256 === sha256,
    );
    if (existing) return { added: false, record: existing };

    const at = now();
    // The id's suffix covers the whole key, not just the payload: the same bytes saved as two kinds
    // in one millisecond would otherwise share an id, and the second would overwrite the first.
    const key = createHash("sha256").update(`${site}\0${retailer}\0${kind}\0${sha256}`).digest("hex");
    /** @type {CaptureRecord} */
    const record = {
      id: `${stamp(at)}-${key.slice(0, 12)}`,
      site,
      retailer,
      kind,
      capturedAt: at.toISOString(),
      sha256,
      bytes: Buffer.byteLength(payload),
    };

    // Payload first, record second, each written whole and renamed into place. A crash between
    // them leaves a payload with no record, which list() never sees — not a record with no payload.
    writeWhole(payloadPath(record.id), seal(payload));
    writeWhole(path.join(dir, `${record.id}.json`), JSON.stringify(record, null, 2));
    return { added: true, record };
  }

  /**
   * A saved payload, as it arrived.
   * @param {string} id
   */
  function read(id) {
    check(id);
    return open(readFileSync(payloadPath(id)));
  }

  /**
   * Lets go of a capture once SageFin holds it. The record goes first, so a crash between the two
   * leaves a payload nothing lists, never a record that promises bytes which are gone.
   * @param {string} id
   */
  function remove(id) {
    check(id);
    rmSync(path.join(dir, `${id}.json`), { force: true });
    rmSync(payloadPath(id), { force: true });
  }

  /** @param {string} id */
  function check(id) {
    if (!/^[0-9TZ]+-[0-9a-f]{12}$/.test(id)) throw new Error("Not a capture id.");
  }

  return { list, add, read, remove };
}

/** @param {string} file @param {string | Uint8Array} data */
function writeWhole(file, data) {
  const partial = `${file}.partial`;
  writeFileSync(partial, data, { mode: 0o600 });
  renameSync(partial, file);
}

/** @param {unknown} value @returns {value is CaptureRecord} */
function isRecord(value) {
  if (!value || typeof value !== "object") return false;
  const r = /** @type {Record<string, unknown>} */ (value);
  return (
    typeof r.id === "string" &&
    typeof r.site === "string" &&
    typeof r.retailer === "string" &&
    typeof r.kind === "string" &&
    typeof r.capturedAt === "string" &&
    typeof r.sha256 === "string" &&
    typeof r.bytes === "number"
  );
}

/** A filename-safe UTC stamp, to the millisecond. @param {Date} date */
function stamp(date) {
  return date.toISOString().replace(/[-:.]/g, "");
}
