/** Static seed loader — files in e2e/test-data/ are reference data, never mutated (§8). */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TEST_DATA_DIR } from './paths';
import type { MultipartFile } from '../api/http';

const MIME_BY_EXT: Record<string, string> = {
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

export function samplePath(name: string): string {
  return path.join(TEST_DATA_DIR, name);
}

/** Load a sample as a multipart-ready file part. */
export function sampleFile(name: string): MultipartFile {
  const filePath = samplePath(name);
  return {
    name,
    mimeType: MIME_BY_EXT[path.extname(name).toLowerCase()] ?? 'application/octet-stream',
    buffer: fs.readFileSync(filePath),
  };
}
