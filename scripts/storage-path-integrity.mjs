import fs from 'node:fs';
import path from 'node:path';

function clean(value) { return String(value ?? '').trim(); }

function assertDirectoryRoot(rootPath, label, fsModule = fs) {
  const resolved = path.resolve(clean(rootPath));
  if (!clean(rootPath)) throw new Error(`${label} is not configured.`);
  if (!fsModule.existsSync(resolved)) throw new Error(`${label} is missing: ${resolved}`);
  const stat = fsModule.lstatSync(resolved);
  if (stat.isSymbolicLink()) {
    const error = new Error(`${label} must not be a symbolic link: ${resolved}`);
    error.code = 'ATHLYRAX_STORAGE_SYMLINK_BLOCKED';
    throw error;
  }
  if (!stat.isDirectory()) throw new Error(`${label} is not a directory: ${resolved}`);
  return resolved;
}

function walkNoSymlinks(rootPath, label, fsModule = fs) {
  const root = assertDirectoryRoot(rootPath, label, fsModule);
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fsModule.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      const relative = path.relative(root, fullPath);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        const error = new Error(`${label} contains an unsafe path outside its root: ${fullPath}`);
        error.code = 'ATHLYRAX_STORAGE_PATH_ESCAPE_BLOCKED';
        throw error;
      }
      const stat = fsModule.lstatSync(fullPath);
      if (stat.isSymbolicLink()) {
        const error = new Error(`${label} contains a symbolic link. Refusing ambiguous storage routing: ${fullPath}`);
        error.code = 'ATHLYRAX_STORAGE_SYMLINK_BLOCKED';
        throw error;
      }
      if (stat.isDirectory()) stack.push(fullPath);
    }
  }
  return root;
}

export function assertNoSymlinkStorageLayout(configuration, fsModule = fs) {
  if (!configuration || typeof configuration !== 'object') throw new Error('Storage configuration is required.');
  const storageRoot = walkNoSymlinks(configuration.storageRoot, 'Primary storage root', fsModule);
  const backupRoot = walkNoSymlinks(configuration.backupRoot, 'Safety backup root', fsModule);
  const relative = path.relative(storageRoot, backupRoot);
  if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    const error = new Error('Safety backup root must remain outside primary storage root.');
    error.code = 'ATHLYRAX_STORAGE_ROOT_OVERLAP_BLOCKED';
    throw error;
  }
  return Object.freeze({ storageRoot, backupRoot });
}
