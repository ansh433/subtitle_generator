// worker/src/services/filesystem/node-filesystem.service.ts

import { promises as fs } from 'fs';
import path from 'path';
import { IFileSystemService } from './filesystem.interface.js';

export class NodeFileSystemService implements IFileSystemService {
  async createTempDir(jobId: string): Promise<string> {
    const tempDir = path.join('/tmp', jobId);
    console.log(`[FileSystem] Creating temp directory: ${tempDir}`);
    
    await fs.mkdir(tempDir, { recursive: true });
    
    return tempDir;
  }

  async cleanup(dirPath: string): Promise<void> {
    console.log(`[FileSystem] Cleaning up: ${dirPath}`);
    
    try {
      await fs.rm(dirPath, { recursive: true, force: true });
      console.log(`[FileSystem] Cleaned up successfully: ${dirPath}`);
    } catch (err) {
      console.error(`[FileSystem] Failed to cleanup ${dirPath}:`, err);
      // Don't throw - cleanup failures shouldn't crash the worker
    }
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    console.log(`[FileSystem] Writing file: ${filePath}`);
    await fs.writeFile(filePath, content);
  }

  async readFile(filePath: string): Promise<string> {
    console.log(`[FileSystem] Reading file: ${filePath}`);
    return await fs.readFile(filePath, 'utf-8');
  }
}