import { IJobProcessor, JobData } from '../interfaces/job-processor.interface.js';
import { TranscribeProcessor } from './transcribe.processor.js';
import { EmbedSubtitlesProcessor } from './embed-subtitles.processor.js';
import { IStorageService } from '../services/storage/storage.interface.js';
import { IStateService } from '../services/state/state.interface.js';
import { IFileSystemService } from '../services/filesystem/filesystem.interface.js';
import { ITranscriptionService } from '../services/transcription.service.js';
import { IAudioService } from '../services/audio.service.js';

export class ProcessorFactory {
  private transcribeProcessor: TranscribeProcessor;
  private embedSubtitlesProcessor: EmbedSubtitlesProcessor;

  constructor(
    storageService: IStorageService,
    stateService: IStateService,
    fileSystemService: IFileSystemService,
    audioService: IAudioService,
    transcriptionService: ITranscriptionService
  ) {
    this.transcribeProcessor = new TranscribeProcessor(
      storageService,
      stateService,
      fileSystemService,
      audioService,
      transcriptionService
    );

    this.embedSubtitlesProcessor = new EmbedSubtitlesProcessor(
      storageService,
      stateService,
      fileSystemService
    );
  }

  getProcessor(jobType: string): IJobProcessor {
    const normalizedType = jobType.toLowerCase();
    
    switch (normalizedType) {
      case 'transcribe':
        return this.transcribeProcessor;
      
      case 'embed_subtitles':
        return this.embedSubtitlesProcessor;

      case 'process_video':
        return {
          process: async (jobData: JobData) => {
            const subtitleUrl = await this.transcribeProcessor.process(jobData);
            jobData.subtitleUrl = subtitleUrl; 
            const embeddedVideoUrl = await this.embedSubtitlesProcessor.process(jobData);
            return embeddedVideoUrl; 
          }
        };
      
      default:
        throw new Error(`Unknown job type: ${jobType}`);
    }
  }
}