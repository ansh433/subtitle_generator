// worker/src/services/storage/s3-storage.service.ts

import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { createWriteStream } from 'fs';
import { promises as fs } from 'fs';
import { pipeline } from 'stream/promises';
import { IStorageService } from './storage.interface.js';

export class S3StorageService implements IStorageService {
  constructor(
    private s3Client: S3Client,
    private bucketName: string
  ) {}

  async download(key: string, localPath: string): Promise<void> {
    console.log(`[S3Storage] Downloading ${key} to ${localPath}`);
    
    const command = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: key,
    });
    
    const response = await this.s3Client.send(command);
    
    // Stream to disk (memory-efficient)
    await pipeline(
      response.Body as NodeJS.ReadableStream,
      createWriteStream(localPath)
    );
    
    console.log(`[S3Storage] Downloaded ${key} successfully`);
  }

  async upload(localPath: string, key: string, contentType: string): Promise<string> {
    console.log(`[S3Storage] Uploading ${localPath} to ${key}`);
    
    const fileContent = await fs.readFile(localPath);
    
    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: key,
      Body: fileContent,
      ContentType: contentType,
    });
    
    await this.s3Client.send(command);
    
    console.log(`[S3Storage] Uploaded to ${key} successfully`);
    return key;
  }

  async exists(key: string): Promise<boolean> {
    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      });
      await this.s3Client.send(command);
      return true;
    } catch (err: any) {
      if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
        return false;
      }
      throw err;
    }
  }
}