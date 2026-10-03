// Shown in the main window when the site did not load. The main process passes the site it was
// trying to open; the link is only ever one of the three SageFin origins, which the main
// process's navigation rules check again when it is clicked.
const site = new URLSearchParams(location.search).get("site") ?? "";
document.getElementById("retry").href = site;
document.getElementById("where").textContent = site ? `Trying to open ${new URL(site).host}.` : "";
