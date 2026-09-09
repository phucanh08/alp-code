#!/usr/bin/env node
"use strict";

// Postinstall is eager warm-up only. `npm --ignore-scripts` remains supported because the
// launcher calls the same function, and an offline npm install must not be rolled back.
const { ensurePayload } = require("./lib/install-payload.cjs");

ensurePayload().then(
  ({ executable }) => console.log(`alp-code native payload ready: ${executable}`),
  (error) => console.warn(`alp-code payload will be installed on first run: ${error.message}`),
);
