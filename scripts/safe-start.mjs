import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import express from 'express';
import {
  installDataSafetyGuards,
  installExpressDbRevisionResponseGuard,
} from './data-safety-preload.mjs';
import { installDbRevisionPutResponse } from './db-revision-put-response.mjs';
import { installSignupLegalAcceptanceGuard } from './signup-legal-acceptance-preload.mjs';
import { runStorageSafetyCheck } from './storage-safety-lib.mjs';

const __filename = fileURLToPath(import.meta.url);
const sourceRoot = path.resolve(path.dirname(__filename), '..');
const repoRoot = path.basename(sourceRoot).toLowerCase() === 'src'
  ? path.resolve(sourceRoot, '..')
  : sourceRoot;
const entryPath = path.join(sourceRoot, 'index.js');

runStorageSafetyCheck({
  repoRoot,
  requireFiles: String(
    process.env.ATHLYRAX_CHECK_REQUIRE_FILES
      ?? (String(process.env.NODE_ENV || '').toLowerCase() === 'production' ? 'true' : 'false'),
  ).toLowerCase() !== 'false',
  createDirectories: true,
  linkStorage: true,
});

process.env.ATHLYRAX_SAFE_START_ENFORCED = 'true';

installDataSafetyGuards();
installExpressDbRevisionResponseGuard(express);
installDbRevisionPutResponse(express);
installSignupLegalAcceptanceGuard(express);

await import(pathToFileURL(entryPath).href);
