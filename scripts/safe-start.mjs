import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import express from 'express';
import {
  installDataSafetyGuards,
  installExpressDbRevisionResponseGuard,
} from './data-safety-preload.mjs';
import { installDbRevisionPutResponse } from './db-revision-put-response.mjs';
import { runStorageSafetyCheck } from './storage-safety-lib.mjs';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');
const entryPath = path.join(repoRoot, 'index.js');

runStorageSafetyCheck({
  repoRoot,
  requireFiles: String(
    process.env.ATHLYRAX_CHECK_REQUIRE_FILES
      ?? (String(process.env.NODE_ENV || '').toLowerCase() === 'production' ? 'true' : 'false'),
  ).toLowerCase() !== 'false',
  createDirectories: true,
  linkStorage: true,
});

installDataSafetyGuards();
installExpressDbRevisionResponseGuard(express);
installDbRevisionPutResponse(express);

await import(pathToFileURL(entryPath).href);
