import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type PutObjectCommandInput,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { DependencyUnavailableError, NotFoundError } from '@/common';
import { APP_CONFIG, type AppConfig } from '@/config';

/**
 * Logical groupings inside the bucket.
 *
 * One bucket with key prefixes rather than a bucket per concern: lifecycle
 * rules, replication and access policies are configured once, and a new kind of
 * artefact does not need a Terraform change before anyone can store one.
 *
 * Every key produced by this service starts with one of these, so an object's
 * purpose is readable from its key alone in a console or an access log.
 */
export const StoragePrefix = {
  /** Customer-supplied artwork and uploaded product imagery. */
  ARTWORK: 'artwork',
  /** Print-ready PDFs produced by the render queue. */
  RENDER: 'render',
  /** Generated invoices. */
  INVOICE: 'invoice',
  /** CSV/XLSX report exports, expected to be lifecycle-expired. */
  EXPORT: 'export',
  /** Documents proxied from, or staged for, the DAM. */
  DOCUMENT: 'document',
} as const;

export type StoragePrefix = (typeof StoragePrefix)[keyof typeof StoragePrefix];

export interface PutObjectOptions {
  readonly contentType?: string;
  /** Filename the browser should use when the object is downloaded. */
  readonly downloadFilename?: string;
  /** Small, non-sensitive key/value pairs stored alongside the object. */
  readonly metadata?: Record<string, string>;
  /** `private` unless a value is given. Only set `public-read` deliberately. */
  readonly acl?: PutObjectCommandInput['ACL'];
}

export interface StoredObject {
  readonly key: string;
  readonly size: number;
  readonly contentType?: string;
}

/**
 * Object storage. S3 in every environment — MinIO locally, the real thing in
 * staging and production, which is why `forcePathStyle` is configurable.
 *
 * Objects are private by default and reached through short-lived presigned
 * URLs. The alternative — streaming every artwork download through this API —
 * would put a print-resolution PDF through the Node event loop for no gain,
 * and the alternative to *that*, a public bucket, would make every customer's
 * artwork readable by anyone who could guess a key.
 */
@Injectable()
export class StorageService implements OnModuleDestroy {
  private readonly logger = new Logger(StorageService.name);
  private client?: S3Client;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /** Built on first use so a storage outage cannot delay application startup. */
  private getClient(): S3Client {
    if (this.client) return this.client;

    const { storage } = this.config;

    this.client = new S3Client({
      endpoint: storage.endpoint,
      region: storage.region,
      // MinIO serves buckets as a path segment; AWS serves them as a subdomain.
      forcePathStyle: storage.forcePathStyle,
      credentials: {
        accessKeyId: storage.accessKeyId,
        secretAccessKey: storage.secretAccessKey,
      },
    });

    return this.client;
  }

  /**
   * Builds a tenant-scoped object key.
   *
   * The account id is the first path segment after the prefix, so a bucket
   * policy or a lifecycle rule can be written per tenant, and so a listing
   * scoped to one customer is a prefix query rather than a filter. `name` is
   * sanitised because it frequently originates in a user-supplied filename.
   */
  buildKey(prefix: StoragePrefix, accountId: string, name: string): string {
    const safeName = name
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 180);

    if (safeName.length === 0) {
      throw new Error('Refusing to build an object key from a name with no usable characters');
    }
    return `${prefix}/${accountId}/${safeName}`;
  }

  async put(
    key: string,
    body: Buffer | Readable | string,
    options: PutObjectOptions = {},
  ): Promise<StoredObject> {
    try {
      await this.getClient().send(
        new PutObjectCommand({
          Bucket: this.config.storage.bucket,
          Key: key,
          Body: body,
          ...(options.contentType ? { ContentType: options.contentType } : {}),
          ...(options.downloadFilename
            ? { ContentDisposition: contentDisposition(options.downloadFilename) }
            : {}),
          ...(options.metadata ? { Metadata: options.metadata } : {}),
          ...(options.acl ? { ACL: options.acl } : {}),
        }),
      );
    } catch (error) {
      throw new DependencyUnavailableError('Object storage', { cause: error });
    }

    const size = Buffer.isBuffer(body) ? body.byteLength : 0;
    this.logger.debug(`Stored ${key}.`);

    return {
      key,
      size,
      ...(options.contentType ? { contentType: options.contentType } : {}),
    };
  }

  /**
   * A time-limited URL the client fetches directly.
   *
   * The expiry is deliberately short (S3_PRESIGN_EXPIRY_SECONDS, 15 minutes by
   * default): a presigned URL is a bearer credential, and one pasted into a
   * chat or an email should stop working before it is forwarded onwards.
   */
  async presignDownload(key: string, downloadFilename?: string): Promise<string> {
    try {
      return await getSignedUrl(
        this.getClient(),
        new GetObjectCommand({
          Bucket: this.config.storage.bucket,
          Key: key,
          ...(downloadFilename
            ? { ResponseContentDisposition: contentDisposition(downloadFilename) }
            : {}),
        }),
        { expiresIn: this.config.storage.presignExpirySeconds },
      );
    } catch (error) {
      throw new DependencyUnavailableError('Object storage', { cause: error });
    }
  }

  /**
   * A time-limited URL the client uploads to directly.
   *
   * Keeps a 200 MB print-resolution file out of this process entirely. The
   * caller decides the key, so the tenant prefix is still ours and a client
   * cannot choose where its upload lands.
   */
  async presignUpload(key: string, contentType?: string): Promise<string> {
    try {
      return await getSignedUrl(
        this.getClient(),
        new PutObjectCommand({
          Bucket: this.config.storage.bucket,
          Key: key,
          ...(contentType ? { ContentType: contentType } : {}),
        }),
        { expiresIn: this.config.storage.presignExpirySeconds },
      );
    } catch (error) {
      throw new DependencyUnavailableError('Object storage', { cause: error });
    }
  }

  /** Streams an object back. Prefer presignDownload() for anything large. */
  async getStream(key: string): Promise<Readable> {
    try {
      const result = await this.getClient().send(
        new GetObjectCommand({ Bucket: this.config.storage.bucket, Key: key }),
      );

      if (!(result.Body instanceof Readable)) {
        throw new Error(`Object ${key} did not come back as a readable stream`);
      }
      return result.Body;
    } catch (error) {
      if (isNotFound(error)) throw new NotFoundError('Object');
      throw new DependencyUnavailableError('Object storage', { cause: error });
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.getClient().send(
        new HeadObjectCommand({ Bucket: this.config.storage.bucket, Key: key }),
      );
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw new DependencyUnavailableError('Object storage', { cause: error });
    }
  }

  /** Idempotent: deleting an object that is not there is not an error. */
  async remove(key: string): Promise<void> {
    try {
      await this.getClient().send(
        new DeleteObjectCommand({ Bucket: this.config.storage.bucket, Key: key }),
      );
    } catch (error) {
      if (isNotFound(error)) return;
      throw new DependencyUnavailableError('Object storage', { cause: error });
    }
  }

  onModuleDestroy(): void {
    this.client?.destroy();
  }
}

/**
 * RFC 6266 disposition header.
 *
 * Both forms are emitted: the quoted ASCII fallback for old clients, and the
 * percent-encoded `filename*` that carries the real name. Without the fallback
 * a filename containing a comma or a quote truncates the header.
 */
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** S3 signals a missing key by name or by a bare 404, depending on the call. */
function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    candidate.name === 'NoSuchKey' ||
    candidate.name === 'NotFound' ||
    candidate.$metadata?.httpStatusCode === 404
  );
}
