// How often the panel asks the server for news. The browser preflight shortens these (the server sends
// other values in panel_hello when started with CODEX_ZOTERO_FAST=1); in Codex they stay as they are.
export const timing = {
  navPollMs: 1000,        // model-initiated navigation, and whether a newer panel took over
  annotationsPollMs: 3000, // annotations changed in Zotero
  mapPollMs: 3000,        // a paper map being generated
};
