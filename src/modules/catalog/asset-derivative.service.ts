import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import sharp from 'sharp';
import { z } from 'zod';
import { QueueName, RENDER_RETRY } from '@/shared/queue';
import { PrismaService } from '@/database';
import { StorageService } from '@/shared/storage';

/** The queue payload: an asset id, never the image bytes. */
export const DerivativeJobSchema = z.object({ assetId: z.string().min(1).max(64) });
export type DerivativeJobPayload = z.infer<typeof DerivativeJobSchema>;

/**
 * The two sizes generated per catalogue image.
 *
 * Two, not a ladder. A grid thumbnail and a detail-page preview are what the
 * portal actually renders; every extra size is storage and processing spent on
 * a breakpoint nobody has asked for. `fit: 'inside'` preserves aspect ratio and
 * never upscales, so a small source image is left at its own size rather than
 * being blown up into something blurry.
 */
const DERIVATIVES = [
  { field: 'thumbnailKey', suffix: 'thumb', width: 320, height: 320, quality: 72 },
  { field: 'previewKey', suffix: 'preview', width: 1200, height: 1200, quality: 82 },
] as const;

/**
 * Resized copies of product images.
 *
 * ---------------------------------------------------------------------------
 * Why this is asynchronous
 * ---------------------------------------------------------------------------
 * Decoding a 40-megapixel print source and resizing it twice takes seconds and
 * hundreds of megabytes. Doing it inside the request that attaches the asset
 * would tie an admin's upload to that cost, and doing it inside the API process
 * at all is why the RENDER queue exists — its whole description is "slow,
 * memory hungry, isolated".
 *
 * ---------------------------------------------------------------------------
 * The original is never touched
 * ---------------------------------------------------------------------------
 * Derivatives are additional objects with their own keys. The uploaded file
 * stays exactly as it arrived, because it is what the print pipeline (INT-01)
 * sends to production — a re-encoded, resized copy reaching a printing press is
 * the kind of mistake that is discovered on delivery.
 */
@Injectable()
export class AssetDerivativeService {
  private readonly logger = new Logger(AssetDerivativeService.name);

  /**
   * Above this, the source is left alone.
   *
   * sharp streams, but a genuinely enormous file still costs memory to decode,
   * and an image this size in a product catalogue is a mistake rather than a
   * requirement. The asset still works; it simply has no thumbnail, and the
   * status says why.
   */
  private static readonly MAX_SOURCE_BYTES = 100 * 1024 * 1024;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    @InjectQueue(QueueName.RENDER) private readonly queue: Queue,
  ) {}

  /**
   * Queues derivative generation for an image asset.
   *
   * Never throws into the caller: attaching an asset must succeed whether or
   * not a thumbnail can be scheduled. A failure here leaves the asset PENDING,
   * which `sweepPending()` picks up.
   */
  async enqueue(assetId: string): Promise<void> {
    try {
      await this.queue.add(
        'product-image-derivatives',
        { assetId } satisfies DerivativeJobPayload,
        RENDER_RETRY,
      );
    } catch (error) {
      this.logger.warn(
        `Could not queue derivatives for asset ${assetId}; it stays PENDING for the sweep.`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * Generates and stores the derivatives. Called by the worker.
   *
   * Failure is recorded on the row rather than left silent: an admin looking at
   * a product with no thumbnail should be able to see that generation failed
   * and why, instead of assuming the upload did not work.
   */
  async generate(assetId: string): Promise<void> {
    const asset = await this.prisma.productAsset.findUnique({ where: { id: assetId } });

    if (!asset) {
      // The asset was removed between enqueue and run. Not retryable.
      this.logger.warn(`Asset ${assetId} no longer exists; nothing to generate.`);
      return;
    }

    if (asset.kind !== 'IMAGE') {
      await this.prisma.productAsset.update({
        where: { id: assetId },
        data: { derivativeStatus: 'NOT_APPLICABLE' },
      });
      return;
    }

    if (asset.sizeBytes > AssetDerivativeService.MAX_SOURCE_BYTES) {
      await this.fail(
        assetId,
        `Source is ${Math.round(asset.sizeBytes / 1_048_576)}MB, above the ` +
          `${AssetDerivativeService.MAX_SOURCE_BYTES / 1_048_576}MB limit for derivatives`,
      );
      return;
    }

    try {
      const source = await this.readAll(asset.storageKey);
      const metadata = await sharp(source).metadata();

      const updates: Record<string, string> = {};

      for (const spec of DERIVATIVES) {
        const body = await sharp(source)
          .rotate() // Honour the EXIF orientation before resizing, or portrait
          // photographs come out sideways in the grid.
          .resize(spec.width, spec.height, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality: spec.quality })
          .toBuffer();

        const key = derivativeKey(asset.storageKey, spec.suffix);
        await this.storage.put(key, body, {
          contentType: 'image/webp',
          metadata: { sourceAssetId: assetId },
        });

        updates[spec.field] = key;
      }

      await this.prisma.productAsset.update({
        where: { id: assetId },
        data: {
          ...updates,
          widthPx: metadata.width ?? null,
          heightPx: metadata.height ?? null,
          derivativeStatus: 'READY',
          derivativeError: null,
        },
      });

      this.logger.log(
        `Generated derivatives for asset ${assetId} ` +
          `(${metadata.width ?? '?'}x${metadata.height ?? '?'}).`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.fail(assetId, message);
      // Rethrown so the queue's retry policy applies — a transient storage
      // error deserves another attempt, and the row already says it failed.
      throw error;
    }
  }

  /**
   * Re-queues images that never got their derivatives.
   *
   * Covers three cases: assets that existed before this feature, ones whose
   * enqueue failed, and ones whose job was lost. Bounded per run so a sweep
   * cannot flood the render queue.
   */
  async sweepPending(limit = 100): Promise<number> {
    const pending = await this.prisma.productAsset.findMany({
      where: { kind: 'IMAGE', derivativeStatus: 'PENDING' },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });

    for (const asset of pending) await this.enqueue(asset.id);

    if (pending.length > 0) {
      this.logger.log(`Swept ${pending.length} image(s) back onto the derivative queue.`);
    }
    return pending.length;
  }

  /** Deletes the derivative objects for an asset. Best-effort. */
  async removeDerivatives(thumbnailKey: string | null, previewKey: string | null): Promise<void> {
    for (const key of [thumbnailKey, previewKey]) {
      if (!key) continue;
      try {
        await this.storage.remove(key);
      } catch (error) {
        this.logger.warn(
          `Could not delete derivative ${key}; it is now an orphaned object.`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  private async fail(assetId: string, message: string): Promise<void> {
    await this.prisma.productAsset.update({
      where: { id: assetId },
      data: { derivativeStatus: 'FAILED', derivativeError: message.slice(0, 500) },
    });
    this.logger.warn(`Derivatives failed for asset ${assetId}: ${message}`);
  }

  /**
   * Pulls the whole object into memory.
   *
   * sharp can stream, but it needs random access for some formats and buffers
   * internally anyway; MAX_SOURCE_BYTES is what bounds this rather than the
   * read strategy.
   */
  private async readAll(storageKey: string): Promise<Buffer> {
    const stream = await this.storage.getStream(storageKey);
    const chunks: Buffer[] = [];

    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBufferLike));
    }
    return Buffer.concat(chunks);
  }
}

/**
 * `artwork/catalog/SKU/123-photo.png` -> `artwork/catalog/SKU/123-photo.thumb.webp`
 *
 * Derived from the source key rather than generated fresh, so a derivative is
 * always findable from its original — which is what makes an orphan sweep
 * possible if a row is ever lost.
 */
export function derivativeKey(storageKey: string, suffix: string): string {
  const lastDot = storageKey.lastIndexOf('.');
  const stem = lastDot > storageKey.lastIndexOf('/') ? storageKey.slice(0, lastDot) : storageKey;
  return `${stem}.${suffix}.webp`;
}
