import { parentPort, workerData } from 'node:worker_threads';
import { createClerkClient } from '@clerk/backend';
import { createMcpVerifier } from './auth.js';
// A terminated worker also closes Clerk's network work. No token enters logs.
const { keys, resource, authorization } = workerData;
const verify = createMcpVerifier({ keys, resource, client: createClerkClient(keys) });
try { parentPort.postMessage(await verify(authorization)); } catch { parentPort.postMessage(null); }
