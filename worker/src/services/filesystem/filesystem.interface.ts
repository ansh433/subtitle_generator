// worker/src/services/filesystem/filesystem.interface.ts

export interface IFileSystemService {
  /**
   * Create a temporary directory for job processing
   * @param jobId - Unique job identifier
   * @returns Absolute path to the temp directory
   */
  createTempDir(jobId: string): Promise<string>;

  /**
   * Clean up a directory and all its contents
   * @param dirPath - Path to directory to remove
   */
  cleanup(dirPath: string): Promise<void>;

  /**
   * Write content to a file
   * @param filePath - Destination file path
   * @param content - Content to write
   */
  writeFile(filePath: string, content: string): Promise<void>;

  /**
   * Read content from a file
   * @param filePath - Source file path
   * @returns File content as string
   */
  readFile(filePath: string): Promise<string>;
}