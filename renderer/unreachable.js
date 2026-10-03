// Shown in the main window when the site did not load. The main process passes the site it was
// trying to open, and the link is only ever set to one of the three SageFin origins: anything else
// in the address, a `javascript:` URL included, leaves the link doing nothing. The page cannot
// import lib/site.mjs, so the list is restated here and lib/site.test.mjs holds it to SITES.
const SAGEFIN_ORIGINS = ["https://my.sagefin.app", "https://my-test.sagefin.app", "http://localhost:3000"];

const asked = new URLSearchParams(location.search).get("site") ?? "";
const site = SAGEFIN_ORIGINS.includes(asked) ? asked : null;
if (site) {
  document.getElementById("retry").href = site;
  document.getElementById("where").textContent = `Trying to open ${new URL(site).host}.`;
}
