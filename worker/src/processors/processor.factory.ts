// worker/src/processors/processor.factory.ts

import { IJobProcessor } from '../interfaces/job-processor.interface.js';
import { TranscribeProcessor } from './transcribe.processor.js';
import { IStorageService } from '../services/storage/storage.interface.js';
import { IStateService } from '../services/state/state.interface.js';
import { IFileSystemService } from '../services/filesystem/filesystem.interface.js';
import { ITranscriptionService } from '../services/transcription.service.js';
import { IAudioService } from '../services/audio.service.js';

export class ProcessorFactory {
  private transcribeProcessor: TranscribeProcessor;

  constructor(
    storageService: IStorageService,
    stateService: IStateService,
    fileSystemService: IFileSystemService,
    audioService: IAudioService,
    transcriptionService: ITranscriptionService
  ) {
    // Wire up dependencies
    this.transcribeProcessor = new TranscribeProcessor(
      storageService,
      stateService,
      fileSystemService,
      audioService,
      transcriptionService
    );
  }

  getProcessor(jobType: string): IJobProcessor {
    switch (jobType) {
      case 'TRANSCRIBE':
        return this.transcribeProcessor;
      
      default:
        throw new Error(`Unknown job type: ${jobType}`);
    }
  }
}