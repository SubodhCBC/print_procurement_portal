import { Global, Module } from '@nestjs/common';
import { StorageService } from './storage.service';

/**
 * S3-compatible object storage.
 *
 * Global for the same reason MailerModule is: artwork, rendered PDFs, invoices
 * and report exports are produced by different domain modules, and none of them
 * should import a storage module to write a file.
 */
@Global()
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
