// @ts-check
// The app's check-in with SageFin: what it says, and what it does with the answer.
//
// A member can run the app on several computers. Each would otherwise sync every retailer every
// day by itself, and a retailer that turned one away would still be asked by the others. So every
// few minutes the app tells SageFin what each retailer's last sync here came to, and is told
// whether this computer may start the scheduled one. Sync now is never asked about.
//
// What is sent is the app's version and, per retailer, four times, who started the last run, how
// it ended and how many orders it opened. Nothing from a retailer's page, ever.
//
// No Electron here: `node --test` runs it bare.

/** How often the app checks in, until SageFin says otherwise. */
export const CHECK_IN_EVERY_MS = 5 * 60 * 1000;

/** The bounds on what SageFin may ask for: never a busy loop, never silence for a day. */
const SOONEST_MS = 60 * 1000;
const LATEST_MS = 60 * 60 * 1000;

/**
 * How long an answer is believed. After that the app has no answer, and with no answer it runs as
 * it would with nobody to ask: a "no" from a SageFin that has since become unreachable must not
 * stop this computer's syncs for good.
 */
export const ANSWER_GOOD_FOR_MS = 15 * 60 * 1000;

/**
 * @typedef {"finished" | "refused" | "signed_out" | "stopped"} RunOutcome
 *
 * @typedef {object} Answer
 * @property {boolean} mayRunScheduled
 * @property {string} reason   SageFin's: unclaimed, holder, takeover, other_computer or refused.
 * @property {string | null} heldBy     The computer that has the daily sync, when it is another.
 * @property {string | null} refusedAt  When the retailer turned a run away on any computer.
 * @property {{ id: string, expiresAt: string } | null} [requestedSync]
 *   A sync the member asked this computer to start, from the web. SageFin hands it over once.
 *
 * @typedef {object} CheckIn
 * @property {"answered" | "signed-out" | "unavailable"} status
 *   `unavailable` is everything that is not an answer: offline, an older SageFin with no such
 *   address, an error. The app then behaves as it did before it could ask.
 * @property {Record<string, Answer>} answers  By retailer code. Empty unless answered.
 * @property {number} againInMs
 */

/**
 * What the app says about one retailer: its sync memory, minus everything about orders, and
 * whether the member's choices let the app sync that retailer by itself (lib/consent.mjs).
 * @param {string} retailer
 * @param {import("./sync-plan.mjs").SyncState} state
 * @param {boolean} automationAllowed
 */
export function report(retailer, state, automationAllowed) {
  return {
    retailer,
    lastRunAt: state.lastRunAt,
    lastRunBy: state.lastRunBy,
    lastRunOutcome: state.lastOutcome,
    lastRunOrders: state.lastOrders,
    lastFinishedAt: state.lastFinishedAt,
    refusedAt: state.refusedAt,
    automationAllowed,
  };
}

/** @param {unknown} v */
const str = (v) => (typeof v === "string" ? v : null);

/**
 * @param {object} options
 * @param {string} options.site     The SageFin origin.
 * @param {string} options.secret   This computer's upload credential.
 * @param {string} options.version  The app's version.
 * @param {ReturnType<typeof report>[]} options.reports
 * @param {typeof globalThis.fetch} options.fetch
 * @returns {Promise<CheckIn>}
 */
export async function checkIn({ site, secret, version, reports, fetch }) {
  /** @type {CheckIn} */
  const none = { status: "unavailable", answers: {}, againInMs: CHECK_IN_EVERY_MS };

  let response;
  try {
    response = await fetch(`${site}/api/v1/retail/desktop/check-in`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ appVersion: version, retailers: reports }),
    });
  } catch {
    return none;
  }

  if (response.status === 401 || response.status === 403) return { ...none, status: "signed-out" };
  if (response.status !== 200) return none;

  const body = await response.json().catch(() => null);
  if (!body || !Array.isArray(body.retailers)) return none;

  /** @type {Record<string, Answer>} */
  const answers = {};
  for (const r of body.retailers) {
    // An answer that does not say yes or no outright is not an answer.
    if (typeof r?.retailer !== "string" || typeof r.mayRunScheduled !== "boolean") continue;
    answers[r.retailer] = {
      mayRunScheduled: r.mayRunScheduled,
      reason: str(r.reason) ?? "",
      heldBy: str(r.heldBy),
      refusedAt: str(r.refusedAt),
      // A request that does not say when it lapses is not one to start.
      requestedSync:
        typeof r.requestedSync?.requestId === "string" && typeof r.requestedSync?.expiresAt === "string"
          ? { id: r.requestedSync.requestId, expiresAt: r.requestedSync.expiresAt }
          : null,
    };
  }

  const asked = Number(body.checkInAgainInSeconds) * 1000;
  const againInMs = Number.isFinite(asked) ? Math.min(LATEST_MS, Math.max(SOONEST_MS, asked)) : CHECK_IN_EVERY_MS;
  return { status: "answered", answers, againInMs };
}

/**
 * The answer for a retailer, if SageFin gave one recently enough to act on. Null is "nobody to
 * ask", which is not "no".
 * @param {{ at: number, answers: Record<string, Answer> } | null} last
 * @param {string} retailer
 * @param {number} now  Milliseconds since the epoch.
 */
export function standingAnswerFor(last, retailer, now) {
  if (!last || now - last.at > ANSWER_GOOD_FOR_MS || now < last.at) return null;
  return last.answers[retailer] ?? null;
}

/**
 * Whether SageFin's answer lets this computer start a scheduled run. With no answer it does: the
 * app runs as it did before it could ask, rather than never syncing.
 * @param {Answer | null} answer
 */
export function scheduleAllowedBy(answer) {
  return answer ? answer.mayRunScheduled : true;
}

/**
 * Whether a refusal this computer remembers has been lifted elsewhere: the member ran Sync now on
 * another computer and it finished. The app reports its own refusal with every check-in, so an
 * answer that names none means SageFin weighed it and found a later finished run.
 * @param {import("./sync-plan.mjs").SyncState} state
 * @param {Answer | null} answer
 */
export function refusalLifted(state, answer) {
  return Boolean(state.refusedAt) && answer !== null && answer.refusedAt === null && answer.reason !== "refused";
}

/**
 * Why no scheduled run will start here, as a sentence for the member, or null when one may.
 * @param {Answer | null} answer
 * @param {string} retailerName
 */
export function waitingSentence(answer, retailerName) {
  if (!answer || answer.mayRunScheduled) return null;
  if (answer.reason === "refused") {
    return `${retailerName} turned a sync away on one of your computers. Press Sync now to try again.`;
  }
  // The credential is named "SageFin Desktop (Derek's MacBook Air)", and this sentence is read
  // inside SageFin Desktop: the computer's own name is the part that says which one.
  const computer = answer.heldBy ? (/^SageFin Desktop \((.+)\)$/.exec(answer.heldBy.trim())?.[1] ?? answer.heldBy.trim()) : "";
  return computer
    ? `The daily sync runs on ${computer}. Sync now still works here.`
    : "The daily sync runs on another of your computers. Sync now still works here.";
}

/**
 * Whether a sync the member asked for from elsewhere should start here, now.
 *
 * It runs as a scheduled sync does, with nobody at the computer, so it starts only where one
 * would: the member has finished a sync of this retailer here themselves, the retailer has not
 * turned a run away since, and the last run did not meet a sign-in page. SageFin checks the same
 * things before it takes the request; they are checked again here because this computer knows
 * them first. And never after the request has lapsed: a computer that wakes up tomorrow does not
 * run this morning's request.
 *
 * The member's choices are not looked at here. Every sync passes that gate where it starts.
 * @param {import("./sync-plan.mjs").SyncState} state
 * @param {Answer | null} answer
 * @param {number} now  Milliseconds since the epoch.
 */
export function shouldStartRequested(state, answer, now) {
  const request = answer?.requestedSync;
  if (!request) return false;
  const lapses = Date.parse(request.expiresAt);
  if (!Number.isFinite(lapses) || lapses <= now) return false;
  return Boolean(state.lastFinishedAt) && !state.refusedAt && state.lastOutcome !== "signed_out";
}
