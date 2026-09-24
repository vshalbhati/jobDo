/* global window */
// Every job board implements the same small interface, and main.js talks only
// to this. Adding a board is one more file that calls register().
//
//   id                 matches shared/sites.js
//   matches(hostname)  is this adapter responsible for the current page
//   collectJobs()      -> { jobs: [...], hasNext }
//   readJob(job)       -> { ok, title, company, description, hasQuickApply, hasExternalApply }
//   openJob(job)       -> same, for boards where we click a card instead of navigating
//   quickApply(job, cfg, report) -> { status, reason, unknowns? }
//   clickExternalApply()         -> { ok, reason }
//   goToNextPage()     -> boolean
//
// A job carries { jobId, title, company, location, url, quickApply, alreadyApplied }.
window.LEA = window.LEA || {};

(function (LEA) {
  const adapters = [];

  function register(adapter) {
    adapters.push(adapter);
    return adapter;
  }

  function current() {
    const host = location.hostname.toLowerCase();
    return adapters.find((a) => a.matches(host)) || null;
  }

  LEA.sites = { register, current, all: adapters };
})(window.LEA);
