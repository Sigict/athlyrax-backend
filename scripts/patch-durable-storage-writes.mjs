import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

const marker = `// ATHLYRAX_DURABLE_ATOMIC_JSON_WRITES`;
if (!source.includes(marker)) {
  const oldHelper = `function writeAtomicJsonFile(filePath, data) {\n\tconst dir = path.dirname(filePath);\n\tfs.mkdirSync(dir, { recursive: true });\n\tconst tmpPath = path.join(\n\t\tdir,\n\t\t\`${'${'}path.basename(filePath)}.${'${'}process.pid}.${'${'}Date.now()}.tmp\`\n\t);\n\tconst serialized = \`${'${'}JSON.stringify(data, null, 2)}\\n\`;\n\tfs.writeFileSync(tmpPath, serialized, 'utf8');\n\tfs.renameSync(tmpPath, filePath);\n}`;

  const durableHelper = `function writeAtomicJsonFile(filePath, data) {\n${marker}\n\tconst dir = path.dirname(filePath);\n\tfs.mkdirSync(dir, { recursive: true });\n\tconst tmpPath = path.join(\n\t\tdir,\n\t\t\`${'${'}path.basename(filePath)}.${'${'}process.pid}.${'${'}Date.now()}.${'${'}crypto.randomBytes(6).toString('hex')}.tmp\`\n\t);\n\tconst serialized = \`${'${'}JSON.stringify(data, null, 2)}\\n\`;\n\tlet fileHandle = null;\n\ttry {\n\t\tfileHandle = fs.openSync(tmpPath, 'wx', 0o600);\n\t\tfs.writeFileSync(fileHandle, serialized, 'utf8');\n\t\tfs.fsyncSync(fileHandle);\n\t} finally {\n\t\tif (fileHandle !== null) fs.closeSync(fileHandle);\n\t}\n\ttry {\n\t\tfs.renameSync(tmpPath, filePath);\n\t} catch (error) {\n\t\ttry { fs.unlinkSync(tmpPath); } catch {}\n\t\tthrow error;\n\t}\n\ttry {\n\t\tconst directoryHandle = fs.openSync(dir, 'r');\n\t\ttry { fs.fsyncSync(directoryHandle); } finally { fs.closeSync(directoryHandle); }\n\t} catch {\n\t\t// Some hosted filesystems do not permit directory fsync. The atomic rename has still completed.\n\t}\n}`;

  if (!source.includes(oldHelper)) throw new Error('Could not find atomic JSON helper anchor for durable-write patch.');
  source = source.replace(oldHelper, durableHelper);
}

for (const required of [
  marker,
  `crypto.randomBytes(6).toString('hex')`,
  `fs.openSync(tmpPath, 'wx', 0o600)`,
  `fs.fsyncSync(fileHandle)`,
  `fs.renameSync(tmpPath, filePath)`,
  `fs.fsyncSync(directoryHandle)`,
]) {
  if (!source.includes(required)) throw new Error(`Durable storage write verification failed: ${required}`);
}

fs.writeFileSync(indexPath, source, 'utf8');
console.log('DURABLE_STORAGE_WRITES_PATCH_OK');
