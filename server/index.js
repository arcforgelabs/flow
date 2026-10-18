#!/usr/bin/env node
import { createApp } from './app.js';

const port = Number(process.env.FLOW_PORT || process.env.PORT || 19300);

createApp().listen(port, () => {
  console.log(`[flow] listening on ${port}`);
});
