// @ts-check
// Private mode on this computer: carries out lib/private-mode.mjs's decisions.
//
// - **Unlock this window.** The locked page's own "Unlock with Touch ID / Windows Hello on this
//   computer" starts the unlock; so does the menu's Unlock SageFin…, which opens the app's own
//   unlock window, whose Unlock button does. Whichever starts it, Touch ID or Windows Hello asks the
//   person, with the same fixed sentence, and the window's own sign-in asks and approves. The page
//   may ask; only the operating system's prompt approves.
// - **The unlock window opens by itself only for a page that offers no way in.** When SageFin's
//   window is shown on a locked household and this computer holds a key of it, the app waits a few
//   seconds for the page to ask whether this computer holds a key. The locked page asks as it
//   appears, then draws its own button (or the phone's code), so nothing opens over it. A page that
//   has not asked by then (a web app from before it did) gets the unlock window, as it always did.
// - **Sync and lock.** When the check-in says your bank has new activity, a notification asks,
//   at most once a locked period and never twice in six hours. Clicking it shows the window and the
//   same unlock window, for a Sync and lock, asked the same way.
// - **Adding this computer.** From the menu: the app makes two keys in the security chip, asks to
//   be added, and shows a QR code for your phone to scan, with the same code beside it to type,
//   then the twelve characters both screens show. Your phone adds it; this computer then unlocks
//   once to prove it.
// - **A member with no phone** (lib/first-holder.mjs). From the menu, or the page's ask that only
//   opens this window: Make This Household Private… makes the household's key in the security
//   chip, shows the four recovery codes and has one typed back, then asks Touch ID or Windows Hello
//   twice. Add a Device… takes the code a new phone or computer shows, has the person compare the
//   twelve characters group by group, and asks once. SageFin then opens only in this window,
//   unlocked here; a browser is never unlocked by this computer.
// - **What the page may ask.** Whether this computer holds a key of the household it names (a yes
//   or no); to unlock this window, which goes straight to the operating system's prompt and tells
//   the page only how it ended; and to show the unlock window or start adding this computer, as the
//   menu does. Only straight after a press on the page, with the window in front and the screen
//   unlocked, and not again within ten seconds. The page sends nothing that goes in the prompt, and
//   no key or anything of one comes back. What approves is the person, at the prompt.
// - **A record of every use**, kept on this computer, which SageFin cannot erase.

import { BrowserWindow, Notification, clipboard, dialog, ipcMain, powerMonitor } from "electron";
import { hostname } from "node:os";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  NO_NOTICES,
  PAGE_OFFER_WAIT_MS,
  SYNC_NOTICE,
  beginEnrolment,
  enrolmentQrText,
  holderTokens,
  holdingOf,
  holdsKeyFor,
  forgetsHolding,
  failureReason,
  failedSaying,
  householdStanding,
  menuChoices,
  lockedForThisWindow,
  logged,
  lookAtEnrolment,
  syncNotice,
  typedCode,
  unlockAskedByPage,
  unlockHere,
  unlockWindowOnShow,
  whyIgnorePageAsk,
  whyNotNow,
} from "../lib/private-mode.mjs";
import { openKeyStore } from "./key-store.mjs";
import { qrRows } from "../lib/qr.mjs";
import { presenceName } from "../lib/key-helper.mjs";
import {
  PROMISE,
  addIdFromTyped,
  approveAdding,
  beginApproving,
  beginGoingPrivate,
  checkGroups,
  codeTexts,
  codesAsText,
  confirmRecoveryCode,
  deviceKind,
  finishGoingPrivate,
  forgetGoingPrivate,
  goPrivateEligibility,
  lookAtApproving,
} from "../lib/first-holder.mjs";

const here = import.meta.dirname;
const PAGE = pathToFileURL(path.join(here, "..", "renderer", "unlock.html")).href;

/** What the system's own prompt is called here: Touch ID, or Windows Hello. */
const PRESENCE = presenceName(process.platform);

/** What SageFin said when it refused, in words for the person here. Codes only; never a raw one. */
const REFUSED = /** @type {Record<string, string>} */ ({
  unknown_holder: "This computer is no longer one of your household's devices. Your phone can add it again.",
  not_private: "This household is not private any more, so this computer no longer holds a key for it. Nothing needs unlocking.",
  standard_again: "This household is not private any more, so this computer no longer holds a key for it. Nothing needs unlocking.",
  other_household: "This computer holds a key for a different household from the one you are signed in to. Nothing was unlocked.",
  nothing_to_sync: "There is nothing new to sync.",
  already_unlocked: "Your household is already unlocked somewhere.",
  key_protection_not_accepted: "This computer cannot hold a key. Unlock with your phone instead.",
  household_file_locked: "Unlock with your phone first, then try again.",
  sign_in_again: "This change needs a recent sign-in. Nothing was changed. Press the button to sign in again, and this will start again.",
  not_eligible: "This household can't be made private right now. SageFin's Settings → Security says why.",
  procedure_in_progress: "A change to this household's keys is already under way. Try again in a few minutes.",
  begin_again: "That didn't finish, and nothing was changed. Start again.",
  proof_not_given: "That took too long, and nothing was changed. Start again.",
  desktop_approves_only_itself: "Your phone adds devices to this household. On your phone: Settings → Security → Devices → Add a device.",
  request_expired: "That code has run out. Start again on the new device.",
  request_used: "That code has already been used. Start again on the new device.",
  device_not_offered: "The new device hasn't finished asking yet. Wait a moment and try again.",
  app_update_required: "Update SageFin on the new device, then start again there.",
  check_not_finished: "The twelve characters weren't compared. Start again.",
  approval_stale: "Your household's devices changed meanwhile. Start again on the new device.",
  keys_do_not_match: "SageFin's answer didn't match what this computer made, so nothing was used. Start again.",
});

/**
 * @param {object} options
 * @param {() => import("../lib/site.mjs").Site} options.site
 * @param {() => BrowserWindow | null} options.window  SageFin's main window, if it exists.
 * @param {() => void} options.showWindow
 * @param {string} options.dir  Where this app keeps its own state.
 * @param {() => void} [options.changed]  What this computer holds changed: the menu says it.
 */
export function startPrivateMode({ site, window, showWindow, dir, changed = () => {} }) {
  const file = path.join(dir, "private-mode.json");
  /** @type {{ holdings: Record<string, import("../lib/private-mode.mjs").Holding>, notices: Record<string, import("../lib/private-mode.mjs").NoticeState>, log: import("../lib/private-mode.mjs").LogEntry[] }} */
  let state = { holdings: {}, notices: {}, log: [] };
  try {
    state = { ...state, ...JSON.parse(readFileSync(file, "utf8")) };
  } catch {
    // Nothing kept yet.
  }
  // Not secrets: which household this computer holds a key of, and its own notices and log.
  const save = () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 1));
    renameSync(`${file}.tmp`, file);
  };

  // Which load of the window's page this is, and the last load whose page asked whether this
  // computer holds a key: a locked page that asks draws its own way in (`unlockWindowOnShow`).
  let pageLoads = 0;
  let offeredOnLoad = -1;
  /** @type {Set<() => void>} Shows of the window waiting to hear whether the page will ask. */
  const offerWaiters = new Set();

  let screenLocked = false;
  powerMonitor.on("lock-screen", () => (screenLocked = true));
  powerMonitor.on("unlock-screen", () => (screenLocked = false));

  const keys = () => openKeyStore(site().key);

  /**
   * SageFin's API on the window's own sign-in: the session cookie the page's sign-in keeps, read
   * here and sent by the main process. Nothing the page says is in a request.
   * @param {BrowserWindow} win
   * @returns {import("../lib/private-mode.mjs").Api}
   */
  function api(win) {
    const origin = site().origin;
    const ses = win.webContents.session;
    /** @param {string} method @param {string} p @param {unknown} [body] */
    const call = async (method, p, body) => {
      const [cookie] = await ses.cookies.get({ url: origin, name: "__session" });
      if (!cookie?.value) return { status: 401, body: null };
      const response = await ses.fetch(`${origin}/api/v1${p}`, {
        method,
        headers: { Authorization: `Bearer ${cookie.value}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    };
    return { post: (p, body) => call("POST", p, body ?? {}), get: (p) => call("GET", p) };
  }

  // ── The unlock window ─────────────────────────────────────────────────────────────────────

  /** @type {BrowserWindow | null} */
  let overlay = null;
  /** @type {((typed?: string) => Promise<void>) | null} */
  let onGo = null;
  /** @type {(() => void) | null} The view's second button, where it has one. */
  let onOther = null;
  /** @type {import("../lib/first-holder.mjs").GoingPrivate | null} Its codes are forgotten when the window closes. */
  let going = null;
  let prompting = false;

  /** @param {Record<string, unknown>} view */
  const show = (view) => {
    // Taller while it shows the enrolment's QR code or the recovery codes, so they and the words fit.
    overlay?.setContentSize(460, view.qr || view.codes ? 680 : view.ask || view.check ? 460 : 360);
    overlay?.webContents.send("unlock:view", view);
    codesShown = Boolean(view.codes);
  };

  /** The recovery codes are on screen, so Copy and Save as file… have something to act on. */
  let codesShown = false;
  ipcMain.handle("unlock:copy", (event) => {
    if (!fromOverlay(event) || !codesShown || !going) return;
    clipboard.writeText(codesAsText(going));
  });
  ipcMain.handle("unlock:save", async (event) => {
    if (!fromOverlay(event) || !codesShown || !going || !overlay) return;
    // The member chooses where; nothing is written without that choice.
    const chosen = await dialog.showSaveDialog(overlay, { title: "Save your recovery codes", defaultPath: "SageFin recovery codes.txt", filters: [{ name: "Text", extensions: ["txt"] }] });
    if (chosen.canceled || !chosen.filePath || !going) return;
    writeFileSync(chosen.filePath, codesAsText(going), { flag: "w" });
  });

  /** @param {BrowserWindow} parent */
  function openOverlay(parent) {
    if (overlay && !overlay.isDestroyed()) return overlay;
    overlay = new BrowserWindow({
      parent,
      modal: true,
      width: 460,
      height: 360,
      resizable: false,
      minimizable: false,
      title: "SageFin Desktop",
      autoHideMenuBar: true,
      webPreferences: { preload: path.join(here, "unlock-preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    overlay.webContents.on("will-navigate", (event) => event.preventDefault());
    overlay.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    overlay.on("closed", () => {
      overlay = null;
      onGo = null;
      onOther = null;
      forgetGoingPrivate(going);
      going = null;
    });
    void overlay.loadURL(PAGE);
    return overlay;
  }

  /** Only the unlock window's own page may press its buttons. @param {Electron.IpcMainInvokeEvent} event */
  const fromOverlay = (event) => Boolean(overlay && event.sender === overlay.webContents && event.senderFrame?.url === PAGE);

  ipcMain.handle("unlock:go", async (event, typed) => {
    if (!fromOverlay(event) || !onGo) return;
    await onGo(typeof typed === "string" ? typed.slice(0, 200) : undefined);
  });
  ipcMain.handle("unlock:other", (event) => {
    if (fromOverlay(event)) onOther?.();
  });
  ipcMain.handle("unlock:cancel", (event) => {
    if (fromOverlay(event)) overlay?.close();
  });

  /** Whether the key may be used now, for a press in the unlock window. The page's ask has its own check, below. */
  function blocked() {
    const win = window();
    return whyNotNow({
      by: "app",
      pageAskAllowed: false,
      screenLocked,
      windowShown: Boolean(win && win.isVisible() && !win.isMinimized()),
      windowFocused: Boolean((win && win.isFocused()) || (overlay && overlay.isFocused())),
      prompting,
    });
  }

  /**
   * @param {import("../lib/private-mode.mjs").PromptKind} what
   * @param {import("../lib/private-mode.mjs").LogEntry["outcome"]} outcome
   * @param {string | null} code
   * @param {string} [reason]  Which step failed, and the error's name, when SageFin did not refuse.
   */
  function record(what, outcome, code, reason) {
    state.log = logged(state.log, { at: new Date().toISOString(), what, outcome, code, ...(reason ? { reason } : {}) });
    save();
  }

  /**
   * An error that would otherwise vanish: its step and name go to the log entry, its message (cut
   * short) to the console. Returns the reason for the entry. Nothing here touches a key or a token.
   * @param {string} step
   * @param {unknown} error
   */
  function failed(step, error) {
    const reason = failureReason(step, error);
    const message = error && typeof error === "object" ? String(/** @type {any} */ (error).message ?? "").slice(0, 200) : "";
    console.warn(`[private-mode] ${reason}${message ? ` - ${message}` : ""}`);
    return reason;
  }

  /**
   * Removed from the household, or the household is no longer private: this computer forgets that
   * it held a key, and both menus stop offering what needs one.
   */
  function forgetHolding() {
    delete state.holdings[site().key];
    save();
    changed();
    void refreshStanding();
  }

  /**
   * What the signed-in household last said of itself, per site, for the menus. Nothing is cached
   * across a sign-out or an error: a failed read is `unknown`, and the menus offer nothing.
   * @type {{ key: string, standing: "standard" | "private" | "unknown", locked: boolean } | null}
   */
  let standingNow = null;
  let reading = false;

  async function refreshStanding() {
    const win = window();
    if (!win || reading) return;
    reading = true;
    const key = site().key;
    try {
      const answer = await api(win).get("/private/status").catch(() => null);
      const next = { key, standing: householdStanding(answer), locked: lockedForThisWindow(answer) };
      const same = standingNow && standingNow.key === next.key && standingNow.standing === next.standing && standingNow.locked === next.locked;
      standingNow = next;
      if (!same) changed();
      if (resumeGoingPrivate && next.standing === "standard") {
        resumeGoingPrivate = false;
        void offerGoingPrivate();
      }
    } finally {
      reading = false;
    }
  }

  /** @param {"full" | "sync"} purpose */
  async function offerUnlock(purpose) {
    const win = window();
    const holding = state.holdings[site().key];
    if (!win || !holding) return false;
    openOverlay(win);
    const what = purpose === "sync" ? "sync" : "unlock";
    const view = {
      title: purpose === "sync" ? "Your bank has new activity" : "SageFin is locked",
      lead:
        purpose === "sync"
          ? `Sync your banks and keep your household locked. You'll be asked to confirm with ${PRESENCE}.`
          : `Unlock SageFin in this window. You'll be asked to confirm with ${PRESENCE}.`,
      button: purpose === "sync" ? "Sync and lock" : "Unlock",
      fine: "This computer asks you each time. It never unlocks a browser; your phone does that.",
    };
    show(view);
    overlay?.webContents.once("did-finish-load", () => show(view));
    onGo = async () => {
      const why = blocked();
      if (why) {
        show({ ...view, said: "Bring SageFin's window to the front, with the screen unlocked, and try again." });
        return;
      }
      prompting = true;
      try {
        const done = await unlockHere({ api: api(win), keys: keys(), holding, purpose });
        record(what, done.outcome, done.code);
        if (forgetsHolding(done.code)) forgetHolding();
        if (done.outcome === "done") {
          overlay?.close();
          if (purpose === "full") win.webContents.reload();
        } else if (done.outcome !== "cancelled") {
          show({ ...view, said: (done.code && REFUSED[done.code]) || "That didn't work. Nothing was unlocked. Try again." });
        }
      } finally {
        prompting = false;
      }
    };
    return true;
  }

  // ── Adding this computer ──────────────────────────────────────────────────────────────────

  async function offerEnrolment() {
    const win = window();
    const store = keys();
    const tokens = holderTokens(process.platform, store);
    if (!win || !tokens) return false;
    openOverlay(win);
    const intro = {
      title: "Use this computer to unlock SageFin",
      lead: `Its key stays in this computer's security chip, and it asks you with ${PRESENCE} each time. Your phone has to add it.`,
      button: "Continue",
      fine: "It unlocks this window and syncs your banks when you say so. It never unlocks a browser.",
    };
    show(intro);
    overlay?.webContents.once("did-finish-load", () => show(intro));
    onGo = async () => {
      if (blocked()) return;
      prompting = true;
      let begun;
      try {
        begun = await beginEnrolment({ api: api(win), keys: store, name: hostname(), tokens });
      } finally {
        prompting = false;
      }
      if (!("enrolment" in begun)) {
        record("enrol", begun.refused === "cancelled" ? "cancelled" : "refused", begun.refused);
        if (begun.refused !== "cancelled") show({ ...intro, said: (begun.refused && REFUSED[begun.refused]) || "That didn't work. Try again." });
        return;
      }
      let enrolment = begun.enrolment;
      onGo = null;
      show({
        title: "Add this computer on your phone",
        lead: "On your phone: Settings → Security → Devices → Add a device, and scan this code. Can't scan? Tap Type the code instead and type the code below it.",
        button: null,
        qr: qrRows(enrolmentQrText(enrolment.addId)),
        code: typedCode(enrolment.addId),
      });
      const poll = setInterval(async () => {
        if (!overlay) return clearInterval(poll);
        const looked = await lookAtEnrolment(api(win), enrolment).catch(() => null);
        if (!looked) return;
        enrolment = looked.enrolment;
        if (looked.show === "check") {
          show({ title: "Compare on your phone", lead: "Your phone shows these twelve characters too. Add this computer only if they match.", button: null, check: enrolment.check });
        } else if (looked.show === "added") {
          clearInterval(poll);
          // Kept once the phone has added it; the first unlock is what proves it.
          state.holdings[site().key] = holdingOf(enrolment);
          save();
          changed();
          void refreshStanding();
          record("enrol", "done", null);
          await offerUnlock("full");
        } else if (looked.show === "ended" || looked.show === "mismatch") {
          clearInterval(poll);
          record("enrol", "failed", null);
          show({ ...intro, said: "This computer was not added. Nothing was changed. Start again." });
        }
      }, 2000);
    };
    return true;
  }

  // ── A member with no phone: making the household private here ─────────────────────────────

  /** Why a household may not go private, in the words SageFin's apps use. */
  const NOT_YET = /** @type {Record<string, string>} */ ({
    not_the_owner: "Only an owner of this household can make it private.",
    more_than_one_member: "This household has more than one member. Making it private from this computer is for a household of one.",
    open_invitation: "An invitation to join this household is waiting. Withdraw it first.",
    finicity_connection: "A bank is connected through Mastercard. Disconnect it first.",
    too_soon_after_going_private: "This household went private less than eight days ago. Try again later.",
    procedure_in_progress: "A change to this household's keys is already under way. Try again in a few minutes.",
    already_private: "This household is already private.",
    wipe_begun: "This household is being deleted.",
    no_file: "This household has no data yet. Add an account first.",
  });

  /** @param {string[] | undefined} reasons */
  const notYet = (reasons) =>
    [...new Set((reasons ?? []).map((r) => NOT_YET[r] ?? "SageFin can't make this household private right now."))].join(" ") ||
    "SageFin can't make this household private right now.";

  /** What going private here means, said before anything is made and again at the last step. */
  const DESKTOP_ONLY =
    "With no phone, SageFin then opens only in SageFin Desktop's window, on a computer that holds the key, and never in a browser. There are no phone notifications, and bank syncs wait until you unlock here. You can add a phone or another computer later.";

  /** The member was going private when SageFin asked for a recent sign-in: after signing in again, the flow starts again. */
  let resumeGoingPrivate = false;

  /**
   * Signs out of this site in the main window and shows its sign-in. Each site has its own browser
   * profile, so clearing it signs out of this site and no other. The sign-in the member does next
   * is recent, which is what the change asked for.
   * @param {BrowserWindow} win
   */
  async function signOutAndBack(win) {
    resumeGoingPrivate = true;
    standingNow = null;
    overlay?.close();
    try {
      await win.webContents.session.clearStorageData();
    } catch {
      // The sign-in page still loads; a session that stayed is signed out from the page's own menu.
    }
    changed();
    await win.loadURL(`${site().origin}/sign-in`);
    showWindow();
  }

  async function offerGoingPrivate() {
    const win = window();
    const store = keys();
    const tokens = holderTokens(process.platform, store);
    if (!win || !tokens || state.holdings[site().key]) return false;
    openOverlay(win);
    const intro = {
      title: "Make this household private",
      lead: `${PROMISE} This computer makes your household's key and keeps it in its security chip, and asks you with ${PRESENCE} each time it is used.`,
      button: "Continue",
      fine: DESKTOP_ONLY,
    };
    show(intro);
    overlay?.webContents.once("did-finish-load", () => show(intro));
    const eligible = await goPrivateEligibility(api(win));
    if (eligible && !eligible.eligible) {
      onGo = null;
      show({ ...intro, button: null, said: notYet(eligible.reasons) });
      return true;
    }

    /** Continue would only be refused again, so it is replaced by the action that fixes it. @param {object} view */
    const offerSignIn = (view) => {
      onOther = null;
      show({ ...view, button: "Sign out and sign in again", said: REFUSED.sign_in_again });
      onGo = async () => {
        await signOutAndBack(win);
      };
    };

    const showFinal = () => {
      onOther = null;
      const view = {
        title: "Make this household private",
        lead: `${PRESENCE} asks twice: once to set up the key, and once to check that it opens your household. Then your household locks, and you unlock it here.`,
        button: "Make private",
        fine: DESKTOP_ONLY,
      };
      show(view);
      onGo = async () => {
        const g = going;
        if (!g) return;
        if (blocked()) {
          show({ ...view, said: "Bring SageFin's window to the front, with the screen unlocked, and try again." });
          return;
        }
        prompting = true;
        /** @type {Awaited<ReturnType<typeof finishGoingPrivate>>} */
        let done;
        try {
          done = await finishGoingPrivate({ api: api(win), keys: store, going: g, name: hostname(), tokens });
        } catch (error) {
          done = { outcome: "failed", code: null, reason: failed("go-private", error) };
        } finally {
          prompting = false;
        }
        if (done.outcome === "failed" && "reason" in done && done.reason) console.warn(`[private-mode] ${done.reason}`);
        record("goPrivate", done.outcome, "code" in done ? done.code : null, "reason" in done ? done.reason : undefined);
        if (done.outcome === "done") {
          state.holdings[site().key] = done.holding;
          save();
          changed();
          void refreshStanding();
          forgetGoingPrivate(g);
          going = null;
          win.webContents.reload();
          await offerUnlock("full");
        } else if (done.outcome === "cancelled") {
          show({ ...view, said: "Your household is not private yet. Press Make private to try again." });
        } else {
          if (done.code === "sign_in_again") return offerSignIn(view);
          show({ ...view, said: (done.code && REFUSED[done.code]) || `That didn't work${failedSaying("reason" in done ? done.reason : undefined)}, and your household is not private yet. Try again.` });
        }
      };
    };

    const showCodes = () => {
      const g = going;
      if (!g) return;
      onOther = null;
      show({
        title: "Write down your recovery codes",
        lead: "If this computer is lost or stops working, a recovery code is the only other way into your household. Without this computer and your codes, nobody can open it, SageFin included. Write all four down, and keep them somewhere safe away from this computer.",
        codes: codeTexts(g),
        button: "I've written them down",
        fine: "Each code works once. They are shown only now: SageFin never sees them, and this computer does not keep them. If you copy or save them, keep that somewhere safe, away from this computer, and not in a place others can read.",
      });
      onGo = async () => showConfirm();
    };

    const showConfirm = () => {
      const g = going;
      if (!g) return;
      const n = g.confirmIndex + 1;
      const view = {
        title: `Type code ${n} back`,
        lead: `To be sure it is written down right, type recovery code ${n} as you wrote it. Spaces and capital letters do not matter.`,
        ask: { label: `Recovery code ${n}`, placeholder: "XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" },
        button: "Check",
        other: "Show the codes again",
      };
      show(view);
      onOther = showCodes;
      onGo = async (typed) => {
        if (confirmRecoveryCode(g, typed ?? "")) showFinal();
        else show({ ...view, said: `That isn't code ${n}. Check what you wrote down, or show the codes again.` });
      };
    };

    onGo = async () => {
      if (blocked()) {
        show({ ...intro, said: "Bring SageFin's window to the front, with the screen unlocked, and try again." });
        return;
      }
      /** @type {Awaited<ReturnType<typeof beginGoingPrivate>>} */
      let begun;
      try {
        begun = await beginGoingPrivate({ api: api(win), keys: store });
      } catch (error) {
        failed("begin-private", error);
        begun = { refused: null };
      }
      if (!("going" in begun)) {
        record("goPrivate", "refused", begun.refused);
        if (begun.refused === "sign_in_again") return offerSignIn(intro);
        show({ ...intro, said: begun.refused === "not_eligible" ? notYet(begun.reasons) : (begun.refused && REFUSED[begun.refused]) || "That didn't work, and nothing was changed. Try again." });
        return;
      }
      forgetGoingPrivate(going);
      going = begun.going;
      showCodes();
    };
    return true;
  }

  // ── A member with no phone: adding a device from here ─────────────────────────────────────

  const ORDINALS = ["first", "second", "third"];

  async function offerAddDevice() {
    const win = window();
    const store = keys();
    const holding = state.holdings[site().key];
    if (!win || !holding) return false;
    openOverlay(win);
    const intro = {
      title: "Add a device",
      lead: "Start on the new device. On a phone, open the SageFin app, sign in, and choose to add the phone to your household. On another computer, open SageFin Desktop and choose Use This Computer to Unlock SageFin… from its menu. Then type the code it shows under its QR code.",
      ask: { label: "The code on the new device", placeholder: "0190 AAAA BBBB 7CCC 8DDD EEEE FFFF 0001" },
      button: "Continue",
      fine: `Only add a device that is in front of you. This computer asks you with ${PRESENCE} before it adds one. If you have a phone that holds your household's key, add devices with the phone instead.`,
    };
    show(intro);
    overlay?.webContents.once("did-finish-load", () => show(intro));

    /** @param {string | undefined} typed */
    const start = async (typed) => {
      onOther = null;
      const addId = addIdFromTyped(typed);
      if (!addId) {
        show({ ...intro, said: "That isn't the code. It is 32 letters and numbers in groups of four, under the QR code on the new device." });
        return;
      }
      /** @type {Awaited<ReturnType<typeof beginApproving>>} */
      let begun;
      try {
        begun = await beginApproving({ api: api(win), holding, addId });
      } catch (error) {
        failed("begin-add", error);
        begun = { refused: null };
      }
      if (!("approving" in begun)) {
        record("addDevice", "refused", begun.refused);
        show({ ...intro, said: (begun.refused && REFUSED[begun.refused]) || "That didn't work, and nothing was changed. Check the code and try again." });
        return;
      }
      let approving = begun.approving;
      const name = approving.device.name;
      const kind = deviceKind(approving.platform);
      onGo = null;
      show({ title: "Waiting for the new device", lead: `When the ${kind} “${name}” shows twelve characters, they appear here too.`, button: null });

      const stopped = (/** @type {string} */ said) => {
        onOther = null;
        onGo = start;
        show({ ...intro, said });
      };

      /** @param {number} group */
      const compare = (group) => {
        const groups = checkGroups(/** @type {string} */ (approving.check));
        if (group >= groups.length) return confirmAdd();
        show({
          title: "Compare the twelve characters",
          lead: `The ${kind} “${name}” shows these twelve characters too. Is the ${ORDINALS[group]} group, ${groups[group]}, the same there?`,
          check: approving.check,
          button: "Same",
          other: "Different",
        });
        onGo = async () => compare(group + 1);
        onOther = () => {
          record("addDevice", "refused", "check_differs");
          stopped("Don't add that device: the characters differ, so it may not be yours. Nothing was changed.");
        };
      };

      const confirmAdd = () => {
        onOther = null;
        const view = {
          title: `Add “${name}”`,
          lead: `This ${kind} will hold your household's key and unlock your household. ${PRESENCE} asks once.`,
          check: approving.check,
          button: "Add",
        };
        show(view);
        onGo = async () => {
          if (blocked()) {
            show({ ...view, said: "Bring SageFin's window to the front, with the screen unlocked, and try again." });
            return;
          }
          prompting = true;
          /** @type {Awaited<ReturnType<typeof approveAdding>>} */
          let done;
          try {
            done = await approveAdding({ api: api(win), keys: store, holding, approving });
          } catch (error) {
            done = { outcome: "failed", code: null, reason: failed("add-device", error) };
          } finally {
            prompting = false;
          }
          record("addDevice", done.outcome, done.code, "reason" in done ? done.reason : undefined);
          if (done.outcome === "done") {
            onGo = null;
            show({ title: "Added", lead: `“${name}” now holds your household's key. It finishes by unlocking once, on its own screen.`, button: null, cancel: "Done" });
          } else if (done.outcome === "cancelled") {
            show({ ...view, said: "Nothing was added. Press Add to try again." });
          } else if (forgetsHolding(done.code)) {
            forgetHolding();
            stopped(REFUSED[done.code ?? ""] ?? REFUSED.unknown_holder);
          } else {
            const said = done.code === "household_file_locked" ? "Unlock SageFin in this window first (Unlock SageFin… in the menu), then add the device." : done.code && REFUSED[done.code];
            show({ ...view, said: said || "That didn't work, and nothing was added. Try again." });
          }
        };
      };

      const poll = setInterval(async () => {
        if (!overlay) return clearInterval(poll);
        const looked = await lookAtApproving(api(win), approving).catch(() => null);
        if (!looked) return;
        approving = looked.approving;
        if (looked.show === "check") {
          clearInterval(poll);
          compare(0);
        } else if (looked.show === "ended" || looked.show === "mismatch") {
          clearInterval(poll);
          record("addDevice", "failed", null);
          stopped("That device was not added. Nothing was changed. Start again on the new device.");
        }
      }, 2000);
    };
    onGo = start;
    return true;
  }

  // ── What the page may ask ─────────────────────────────────────────────────────────────────

  /** @type {number | null} */
  let lastPageAsk = null;

  /** The page's ask as it stands now. @returns {import("../lib/private-mode.mjs").PageAsk} */
  function pageAsk() {
    const win = window();
    return {
      lastAt: lastPageAsk,
      now: Date.now(),
      screenLocked,
      windowShown: Boolean(win && win.isVisible() && !win.isMinimized()),
      windowFocused: Boolean(win && win.isFocused()),
      overlayOpen: Boolean(overlay && !overlay.isDestroyed()),
    };
  }

  /** Whether to carry out the page's ask now, counted here so a page cannot nag. */
  function pageMayAsk() {
    const ask = pageAsk();
    if (whyIgnorePageAsk(ask)) return false;
    lastPageAsk = ask.now;
    return true;
  }

  /**
   * The page's "Unlock with Touch ID / Windows Hello on this computer": straight to the operating
   * system's prompt, with the fixed sentence for this window, and on approval the same unlock the
   * unlock window's own button runs. The page is told how it ended, and nothing more.
   * @param {unknown} householdId
   * @returns {Promise<import("../lib/private-mode.mjs").PageUnlockOutcome>}
   */
  async function unlockForPage(householdId) {
    const win = window();
    const holding = state.holdings[site().key];
    if (!win) return "not-now";
    const ask = pageAsk();
    let began = false;
    /** @type {Awaited<ReturnType<typeof unlockAskedByPage>>} */
    let asked;
    try {
      asked = await unlockAskedByPage({
        ask,
        circumstances: { screenLocked: ask.screenLocked, windowShown: ask.windowShown, windowFocused: ask.windowFocused, prompting },
        holding,
        householdId,
        api: api(win),
        keys,
        started: () => {
          began = true;
          lastPageAsk = ask.now;
          prompting = true;
        },
      });
    } catch (error) {
      asked = { outcome: began ? "failed" : "not-now", unlock: began ? { outcome: "failed", code: null, reason: failed("page-unlock", error) } : null };
    } finally {
      if (began) prompting = false;
    }
    const { outcome, unlock } = asked;
    if (!unlock) return outcome;
    record("unlock", unlock.outcome, unlock.code, unlock.reason);
    if (forgetsHolding(unlock.code)) forgetHolding();
    // After the answer has gone back to the page, which the reload replaces.
    if (outcome === "unlocked") setImmediate(() => win.webContents.reload());
    return outcome;
  }

  const canHoldKey = () => Boolean(holderTokens(process.platform, keys()));

  return {
    /** Whether this computer holds a key of the household on the site shown. */
    holdsAKey: () => Boolean(state.holdings[site().key]),

    /**
     * The page's one yes or no: does this computer hold a key of the household it names? Only the
     * locked page asks, and it then draws its own way in, so asking also tells the app not to open
     * its unlock window over this load of the page (`unlockWindowOnShow`).
     */
    pageAsksWhetherItHoldsKey(/** @type {unknown} */ householdId) {
      offeredOnLoad = pageLoads;
      for (const wake of [...offerWaiters]) wake();
      return holdsKeyFor(state.holdings[site().key], householdId);
    },

    /** The window's page started loading again: what the last load said no longer counts. */
    pageLoaded() {
      pageLoads += 1;
      void refreshStanding();
    },

    /** Reads the signed-in household's state again: on sign-in, a site switch, a page load. Rebuilds the menus if it changed. */
    refreshStanding,

    /** Whether this computer could be added at all: a security chip and the prompt that guards it. */
    canHoldKey,

    /** The page's press on its unlock button: the operating system's prompt, then this window unlocks. */
    pageAsksToUnlockHere: unlockForPage,

    /**
     * The page asked to show the unlock window. It only shows it; its button unlocks. What a web
     * app from before "unlock-here" calls; remove it once the web app no longer does.
     */
    async pageAsksToUnlock() {
      if (!state.holdings[site().key] || !pageMayAsk()) return false;
      return offerUnlock("full");
    },

    /** The page asked to open Make This Household Private…, as the menu item does. It only opens this app's window. */
    async pageAsksToGoPrivate() {
      if (state.holdings[site().key] || !canHoldKey() || !pageMayAsk()) return false;
      return offerGoingPrivate();
    },

    /** The page asked to open Add a Device…, as the menu item does. It only opens this app's window. */
    async pageAsksToAddADevice() {
      if (!state.holdings[site().key] || !pageMayAsk()) return false;
      return offerAddDevice();
    },

    /** The page asked to start adding this computer, as the menu item does. */
    async pageAsksToAdd() {
      if (state.holdings[site().key] || !canHoldKey() || !pageMayAsk()) return false;
      return offerEnrolment();
    },

    /** For the app's menu: unlock here, or add this computer. Never offered where it cannot hold a key. */
    menuItems() {
      /** @type {Electron.MenuItemConstructorOptions[]} */
      const items = [];
      const here = standingNow && standingNow.key === site().key ? standingNow : null;
      const choices = menuChoices({ standing: here?.standing ?? "unknown", locked: here?.locked ?? false, holdsAKey: Boolean(state.holdings[site().key]), canHoldKey: canHoldKey() });
      for (const choice of choices) {
        if (choice === "unlock") items.push({ label: "Unlock SageFin…", click: () => void offerUnlock("full") });
        if (choice === "add-device") items.push({ label: "Add a Device…", click: () => void offerAddDevice() });
        if (choice === "enrol") items.push({ label: "Use This Computer to Unlock SageFin…", click: () => void offerEnrolment() });
        if (choice === "go-private") items.push({ label: "Make This Household Private…", click: () => void offerGoingPrivate() });
      }
      return items;
    },

    /**
     * The window was shown: if its household is locked and this computer holds a key, and the page
     * has not said within a few seconds that it offers its own unlock, open the unlock window.
     */
    async onWindowShown() {
      const win = window();
      if (!win || !state.holdings[site().key]) return;
      const shownAt = Date.now();
      const locked = lockedForThisWindow(await api(win).get("/private/status").catch(() => null));
      for (;;) {
        const next = unlockWindowOnShow({ holdsAKey: Boolean(state.holdings[site().key]), locked, pageOffers: offeredOnLoad === pageLoads, waitedMs: Date.now() - shownAt });
        if (next === "open") void offerUnlock("full");
        if (next !== "wait") return;
        await new Promise((resolve) => {
          const wake = () => {
            clearTimeout(timer);
            offerWaiters.delete(wake);
            resolve(undefined);
          };
          const timer = setTimeout(wake, Math.max(0, PAGE_OFFER_WAIT_MS - (Date.now() - shownAt)));
          offerWaiters.add(wake);
        });
      }
    },

    /**
     * The check-in's answer about private mode. A notification at most once a locked period, never
     * twice in six hours, counted here. A click only opens the unlock window; Touch ID unlocks.
     * @param {{ locked: boolean, syncWaiting: boolean } | null} privateMode
     */
    onCheckIn(privateMode) {
      const key = site().key;
      void refreshStanding();
      const { notify, state: next } = syncNotice(state.notices[key] ?? NO_NOTICES, privateMode, Date.now(), { holdsAKey: Boolean(state.holdings[key]) });
      state.notices[key] = next;
      save();
      if (!notify || !Notification.isSupported()) return;
      const notice = new Notification({ title: SYNC_NOTICE.title, body: SYNC_NOTICE.body });
      notice.on("click", () => {
        showWindow();
        void offerUnlock("sync");
      });
      notice.show();
    },

    /** This computer's record of every use of its key, newest last. */
    log: () => state.log,
  };
}
