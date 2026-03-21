// worker/src/services/storage/storage.interface.ts

export interface IStorageService {
  /**
   * Download a file from cloud storage to local disk using streams
   * @param key - Storage key (e.g., S3 object key)
   * @param localPath - Destination path on local filesystem
   */
  download(key: string, localPath: string): Promise<void>;

  /**
   * Upload a file from local disk to cloud storage
   * @param localPath - Source path on local filesystem
   * @param key - Destination storage key
   * @param contentType - MIME type of the file
   * @returns The storage key where file was uploaded
   */
  upload(localPath: string, key: string, contentType: string): Promise<string>;

  /**
   * Check if a file exists in storage
   * @param key - Storage key to check
   * @returns True if file exists, false otherwise
   */
  exists(key: string): Promise<boolean>;
}