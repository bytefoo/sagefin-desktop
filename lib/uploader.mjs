// @ts-check
// Sends saved pages to SageFin, oldest first, and lets go of each one SageFin holds.
//
// The server reads the page; this never looks inside one. It posts the bytes as they were
// saved and acts on the status alone.

/**
 * @typedef {object} Sent
 * @property {string} retailer
 * @property {string} kind
 * @property {string} status       The server's: parsed, unsupported or failed.
 * @property {number | null} orders
 * @property {number | null} ordersMatched
 *
 * @typedef {object} UploadSummary
 * @property {Sent[]} sent     Captures SageFin now holds; each was removed from this computer.
 * @property {number} refused  Captures SageFin would not take as they are; kept here.
 * @property {"signed-out" | "busy" | "offline" | "server" | null} stopped
 *   Why the run ended before the queue did, or null when it reached the end.
 */

/**
 * @param {object} options
 * @param {{ list: () => import("./capture-store.mjs").CaptureRecord[], read: (id: string) => string, remove: (id: string) => void }} options.store
 * @param {string} options.site    The SageFin origin to send to. Only pages saved under it go.
 * @param {string} options.secret
 * @param {typeof fetch} options.fetch
 * @returns {Promise<UploadSummary>}
 */
export async function uploadPending({ store, site, secret, fetch }) {
  /** @type {UploadSummary} */
  const summary = { sent: [], refused: 0, stopped: null };

  for (const record of store.list()) {
    // A page saved while the app showed another SageFin belongs to that one.
    if (record.site !== site) continue;

    let response;
    try {
      response = await fetch(`${site}/api/v1/retail/captures`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          retailer: record.retailer,
          kind: record.kind,
          payload: store.read(record.id),
          capturedAt: record.capturedAt,
        }),
      });
    } catch {
      summary.stopped = "offline";
      return summary;
    }

    // 200 is "read", 202 is "held": either way SageFin has the bytes, so this copy can go.
    if (response.status === 200 || response.status === 202) {
      const body = await response.json().catch(() => null);
      store.remove(record.id);
      summary.sent.push({
        retailer: record.retailer,
        kind: record.kind,
        status: typeof body?.status === "string" ? body.status : response.status === 200 ? "parsed" : "unsupported",
        orders: Number.isInteger(body?.orders) ? body.orders : null,
        ordersMatched: Number.isInteger(body?.ordersMatched) ? body.ordersMatched : null,
      });
      continue;
    }

    // The credential is no longer good. Nothing later in the queue will fare differently.
    if (response.status === 401 || response.status === 403) {
      summary.stopped = "signed-out";
      return summary;
    }
    // Another sync of this household is running; the server asks for a retry in a minute.
    if (response.status === 409) {
      summary.stopped = "busy";
      return summary;
    }
    if (response.status === 429 || response.status >= 500) {
      summary.stopped = "server";
      return summary;
    }

    // Any other answer is about this one capture. It stays on disk, and the queue goes on.
    summary.refused += 1;
  }

  return summary;
}

/**
 * @typedef {object} SentTally
 * @property {string} since   ISO 8601: when this tally began, the start of a sync or of the app.
 * @property {string} at      ISO 8601: when the latest page was sent.
 * @property {number} read    Pages SageFin read.
 * @property {number} failed  Pages SageFin holds and could not read.
 * @property {number} held    Pages of a kind SageFin cannot read yet.
 */

/**
 * A tally with one more sent page in it, begun at `now` when there was none.
 * @param {SentTally | undefined} tally
 * @param {Sent} sent
 * @param {Date} now
 * @returns {SentTally}
 */
export function addSent(tally, sent, now) {
  const at = now.toISOString();
  const t = tally ?? { since: at, at, read: 0, failed: 0, held: 0 };
  return {
    ...t,
    at,
    read: t.read + (sent.status === "parsed" ? 1 : 0),
    failed: t.failed + (sent.status === "failed" ? 1 : 0),
    held: t.held + (sent.status !== "parsed" && sent.status !== "failed" ? 1 : 0),
  };
}

/**
 * What has been sent since the tally began, in pages, for the card's "Last sent:".
 *
 * Pages, not orders. A sync sends a list page and then each order's page, and each answer counts the
 * orders on that page, so adding them up counted every order twice; a single page's answer, shown
 * alone, read as if the whole sync had found one order. How many orders a sync read is its own line.
 *
 * @param {SentTally} tally
 * @param {(iso: string) => string} [time]  How a moment is written; the local clock by default.
 */
export function sentSummary(tally, time = localTime) {
  const pages = tally.read + tally.failed + tally.held;
  const when = pages === 1 ? `at ${time(tally.at)}` : `since ${time(tally.since)}`;
  const count = `${pages} page${pages === 1 ? "" : "s"} ${when}`;
  if (tally.read === pages) return `${count}, ${pages === 1 ? "read" : "all read"} by SageFin.`;

  const parts = /** @type {string[]} */ ([
    tally.read > 0 ? `read ${tally.read}` : null,
    tally.failed > 0 ? `could not read ${tally.failed}` : null,
    tally.held > 0 ? `cannot read ${tally.held} yet` : null,
  ].filter(Boolean));
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
  return `${count}. SageFin ${list}.`;
}

/** @param {string} iso */
function localTime(iso) {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return sameDay ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}
