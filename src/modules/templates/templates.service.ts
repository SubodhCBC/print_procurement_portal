import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Template, TemplateAsset, TemplateVersion } from '@prisma/client';
import {
  BusinessRuleError,
  ConflictError,
  createId,
  NotFoundError,
  offsetPage,
  Role,
  StaleVersionError,
  toSkipTake,
  type AuthenticatedActor,
  type OffsetPage,
} from '@/common';
import { PrismaService } from '@/database';
import { AuditAction, AuditService } from '@/modules/audit';
import { AssetDerivativeService } from '@/modules/catalog';
import { StoragePrefix, StorageService } from '@/shared/storage';
import type {
  SnapshotTemplateDto,
  AttachTemplateAssetDto,
  ChangeTemplateStatusDto,
  CreateTemplateDto,
  CustomiseTemplateDto,
  DuplicateTemplateDto,
  ListTemplatesQueryDto,
  PresignTemplateAssetDto,
  PublishTemplateDto,
  RestoreVersionDto,
  SetTemplateVisibilityDto,
  UpdateTemplateDto,
} from './dto/template.dto';
import {
  readLayers,
  readSnapshot,
  type CustomisableTemplateSource,
  type FullTemplateSource,
  type TemplateSnapshot,
  type TemplateSummarySource,
} from './dto/template-response';
import {
  acceptCustomisation,
  assertPublishable,
  assertLayersWellFormed,
  assertTransition,
  CUSTOMER_VISIBLE_STATUSES,
  normaliseTemplateCode,
  type TemplateStatus,
} from './template-status';

/**
 * The product and category are joined into every read, summary included.
 *
 * A gallery shows "Target product: A2 Gloss Poster", not an id, and the
 * alternative is the client fetching a product per tile — forty round trips to
 * render one screen. Two indexed joins on a page of twenty-five rows cost
 * nothing next to that.
 */
const NAMED_REFERENCES = Prisma.validator<Prisma.TemplateInclude>()({
  product: { select: { id: true, sku: true, name: true } },
  category: { select: { id: true, code: true, name: true } },
  publishedVersion: { select: { version: true } },
});

const FULL_TEMPLATE = Prisma.validator<Prisma.TemplateInclude>()({
  ...NAMED_REFERENCES,
  assets: { orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }] },
  versions: { orderBy: { version: 'desc' }, take: 50 },
  visibleTo: { select: { accountId: true } },
});

const SUMMARY_TEMPLATE = NAMED_REFERENCES;

/**
 * Master artwork templates (SOW FE-13).
 *
 * ---------------------------------------------------------------------------
 * The one idea the rest of this file follows from
 * ---------------------------------------------------------------------------
 * A `Template` row is a **draft**. It is what the builder opens, what autosave
 * writes to, and what `version` counts. What a *buyer* personalises is a
 * `TemplateVersion` — an immutable snapshot taken at publish time.
 *
 * So a designer reworking a live template cannot change the artwork somebody is
 * halfway through ordering, and "publish" is the single deliberate act that
 * moves customers onto new work. Every read below is therefore one of two
 * kinds, and they never share a code path:
 *
 * - **Operator reads** (`list`, `findById`) return the working copy.
 * - **Buyer reads** (`getCustomisable`) return the published snapshot.
 *
 * ---------------------------------------------------------------------------
 * Global, like the catalogue
 * ---------------------------------------------------------------------------
 * Templates are the platform operator's: `TEMPLATE_MANAGE` is in no customer
 * role. There is no `accountId` and no row-level security here. What bounds a
 * customer read is `visibilityFilter()` — one function, for the same reason the
 * catalogue has one: a predicate copied into each query is a predicate that
 * eventually differs in one of them.
 */
@Injectable()
export class TemplatesService {
  private readonly logger = new Logger(TemplatesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly derivatives: AssetDerivativeService,
  ) {}

  // --- Reads ---------------------------------------------------------------------

  /**
   * Which templates this actor may see.
   *
   * An administrator sees everything including drafts, because building the
   * library is their job. Everyone else sees published templates that are
   * either unrestricted or explicitly granted to their account.
   *
   * The `visibleTo: { some: ... }` arm is an EXISTS subquery on
   * `template_account_visibility`, indexed on accountId, so a restricted
   * library does not cost a scan.
   */
  private visibilityFilter(actor: AuthenticatedActor): Prisma.TemplateWhereInput {
    if (actor.role === Role.ADMIN) return {};

    return {
      status: { in: CUSTOMER_VISIBLE_STATUSES as unknown as TemplateStatus[] },
      OR: [
        { visibility: 'ALL_ACCOUNTS' },
        { visibility: 'RESTRICTED', visibleTo: { some: { accountId: actor.accountId } } },
      ],
    };
  }

  async list(
    actor: AuthenticatedActor,
    query: ListTemplatesQueryDto,
  ): Promise<OffsetPage<TemplateSummarySource>> {
    // Composed as an AND array rather than one spread object: the visibility
    // filter and the search filter each contribute a top-level `OR`, and
    // spreading them into one object would silently keep only the last.
    const clauses: Prisma.TemplateWhereInput[] = [
      { deletedAt: null },
      this.visibilityFilter(actor),
    ];

    if (query.categoryId) clauses.push({ categoryId: query.categoryId });
    if (query.productId) clauses.push({ productId: query.productId });
    if (query.theme) clauses.push({ theme: query.theme });
    // A customer asking for DRAFT gets nothing rather than an error: the
    // visibility filter already pinned them to PUBLISHED, and the intersection
    // is empty. That is the filter doing its job, not a fault to report.
    if (query.status) clauses.push({ status: query.status });
    if (query.search) {
      clauses.push({
        OR: [
          { name: { contains: query.search, mode: 'insensitive' } },
          { code: { contains: query.search, mode: 'insensitive' } },
          { description: { contains: query.search, mode: 'insensitive' } },
        ],
      });
    }

    const where: Prisma.TemplateWhereInput = { AND: clauses };
    const { skip, take } = toSkipTake(query);

    const [items, total] = await Promise.all([
      this.prisma.template.findMany({
        where,
        include: SUMMARY_TEMPLATE,
        orderBy: [{ updatedAt: 'desc' }],
        skip,
        take,
      }),
      this.prisma.template.count({ where }),
    ]);

    return offsetPage(items, total, query);
  }

  /** The working copy, for the builder. Bounded by the same visibility filter. */
  async findById(actor: AuthenticatedActor, templateId: string): Promise<FullTemplateSource> {
    const template = await this.prisma.template.findFirst({
      where: { AND: [{ id: templateId, deletedAt: null }, this.visibilityFilter(actor)] },
      include: FULL_TEMPLATE,
    });

    if (!template) throw new NotFoundError('Template not found.', { details: { templateId } });
    return template;
  }

  /**
   * What a buyer personalises: the published snapshot.
   *
   * Deliberately not `findById` with a status check. A template whose draft has
   * moved on since publication must still hand the buyer the artwork that was
   * published, and reading the row would hand them the designer's work in
   * progress.
   */
  async getCustomisable(
    actor: AuthenticatedActor,
    templateId: string,
  ): Promise<{ template: CustomisableTemplateSource; version: TemplateVersion }> {
    const template = await this.prisma.template.findFirst({
      where: {
        AND: [
          { id: templateId, deletedAt: null, status: 'PUBLISHED' },
          this.visibilityFilter(actor),
        ],
      },
      // The product and category come from the live row rather than the
      // snapshot: a product renamed since publication should read by its
      // current name on the customiser, because that is what the buyer will
      // see everywhere else in the shop. The *artwork* is the snapshot's, and
      // that is the part that must not move.
      include: {
        publishedVersion: true,
        product: { select: { id: true, sku: true, name: true } },
        category: { select: { id: true, code: true, name: true } },
      },
    });

    if (!template?.publishedVersion) {
      // One message for "no such template" and "not published to you". Telling
      // them apart would let a customer enumerate the library by watching which
      // ids answer differently.
      throw new NotFoundError('That template is not available.', { details: { templateId } });
    }

    return { template, version: template.publishedVersion };
  }

  /**
   * Cuts a restore point from the current draft, without publishing it.
   *
   * Reuses the version number the draft is already on rather than allocating a
   * new one, which is what makes "restore version 7" mean the same thing
   * whether version 7 was published or merely kept. Snapshotting twice at the
   * same version is therefore a no-op rather than an error: an explicit save
   * that changed nothing should not fail, and it has nothing new to record.
   */
  async snapshot(
    templateId: string,
    dto: SnapshotTemplateDto,
    actor: AuthenticatedActor,
  ): Promise<readonly TemplateVersion[]> {
    const template = await this.requireManageable(actor, templateId);

    const existing = await this.prisma.templateVersion.findUnique({
      where: { templateId_version: { templateId, version: template.version } },
    });

    if (!existing) {
      await this.prisma.templateVersion.create({
        data: {
          id: createId('tpv'),
          templateId,
          version: template.version,
          snapshot: this.buildSnapshot(template) as unknown as Prisma.InputJsonValue,
          label: dto.label ?? 'Saved',
          createdById: actor.userId,
          createdByName: actor.email,
        },
      });
    }

    return this.prisma.templateVersion.findMany({
      where: { templateId },
      orderBy: { version: 'desc' },
    });
  }

  async listVersions(
    actor: AuthenticatedActor,
    templateId: string,
  ): Promise<readonly TemplateVersion[]> {
    await this.requireManageable(actor, templateId);

    return this.prisma.templateVersion.findMany({
      where: { templateId },
      orderBy: { version: 'desc' },
    });
  }

  // --- Writes --------------------------------------------------------------------

  async create(dto: CreateTemplateDto, actor: AuthenticatedActor): Promise<FullTemplateSource> {
    const code = normaliseTemplateCode(dto.code ?? (await this.deriveCode(dto.name)));
    assertLayersWellFormed(dto.layers);
    await this.assertReferencesExist(dto.productId, dto.categoryId);

    const id = createId('tpl');

    try {
      await this.prisma.template.create({
        data: {
          id,
          code,
          name: dto.name,
          description: dto.description ?? null,
          productId: dto.productId ?? null,
          categoryId: dto.categoryId ?? null,
          theme: dto.theme ?? null,
          orientation: dto.orientation,
          aspectRatio: dto.aspectRatio ?? null,
          widthValue: new Prisma.Decimal(dto.widthValue),
          heightValue: new Prisma.Decimal(dto.heightValue),
          dimensionUnit: dto.dimensionUnit,
          bleedMargin: new Prisma.Decimal(dto.bleedMargin),
          safeMargin: new Prisma.Decimal(dto.safeMargin),
          canvasConfig: dto.canvasConfig as Prisma.InputJsonValue,
          layers: dto.layers as unknown as Prisma.InputJsonValue,
          design: (dto.design ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          canvasJson: dto.canvasJson ?? null,
          createdById: actor.userId,
          createdByName: actor.email,
          updatedById: actor.userId,
          updatedByName: actor.email,
        },
      });
    } catch (error) {
      throw this.translateDuplicateCode(error, code);
    }

    await this.audit.record({
      action: AuditAction.TEMPLATE_CREATED,
      entityType: 'TEMPLATE',
      entityId: id,
      entityName: `${code} — ${dto.name}`,
      accountId: actor.accountId,
      details: { code, name: dto.name, productId: dto.productId ?? null },
    });

    return this.findById(actor, id);
  }

  /**
   * A save from the builder, including an autosave.
   *
   * ---------------------------------------------------------------------------
   * Why the version check is a conditional UPDATE and not a read-then-write
   * ---------------------------------------------------------------------------
   * Reading the row, comparing versions and then writing leaves a window
   * between the read and the write in which the other designer's save lands —
   * which is precisely the collision this is meant to catch, arriving too
   * quickly to be seen. The comparison happens *inside* the write, so the
   * database decides, and a zero-row result is the collision.
   */
  async update(
    templateId: string,
    dto: UpdateTemplateDto,
    actor: AuthenticatedActor,
  ): Promise<FullTemplateSource> {
    const existing = await this.requireManageable(actor, templateId);

    if (dto.layers) assertLayersWellFormed(dto.layers);
    await this.assertReferencesExist(dto.productId, dto.categoryId);

    const code = dto.code === undefined ? undefined : normaliseTemplateCode(dto.code);

    // `TemplateUncheckedUpdateManyInput`, not the checked `UpdateInput`: this is
    // an `updateMany` — that is what makes the version comparison happen inside
    // the write — and a conditional update addresses rows, not one row, so
    // foreign keys go in as scalars rather than as relation connects.
    const data: Prisma.TemplateUncheckedUpdateManyInput = {
      ...(code !== undefined ? { code } : {}),
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.description !== undefined ? { description: dto.description } : {}),
      ...(dto.productId !== undefined ? { productId: dto.productId } : {}),
      ...(dto.categoryId !== undefined ? { categoryId: dto.categoryId } : {}),
      ...(dto.theme !== undefined ? { theme: dto.theme } : {}),
      ...(dto.orientation !== undefined ? { orientation: dto.orientation } : {}),
      ...(dto.aspectRatio !== undefined ? { aspectRatio: dto.aspectRatio } : {}),
      ...(dto.widthValue !== undefined ? { widthValue: new Prisma.Decimal(dto.widthValue) } : {}),
      ...(dto.heightValue !== undefined
        ? { heightValue: new Prisma.Decimal(dto.heightValue) }
        : {}),
      ...(dto.dimensionUnit !== undefined ? { dimensionUnit: dto.dimensionUnit } : {}),
      ...(dto.bleedMargin !== undefined
        ? { bleedMargin: new Prisma.Decimal(dto.bleedMargin) }
        : {}),
      ...(dto.safeMargin !== undefined ? { safeMargin: new Prisma.Decimal(dto.safeMargin) } : {}),
      ...(dto.canvasConfig !== undefined
        ? { canvasConfig: dto.canvasConfig as Prisma.InputJsonValue }
        : {}),
      ...(dto.layers !== undefined
        ? { layers: dto.layers as unknown as Prisma.InputJsonValue }
        : {}),
      ...(dto.design !== undefined ? { design: dto.design as Prisma.InputJsonValue } : {}),
      ...(dto.canvasJson !== undefined ? { canvasJson: dto.canvasJson } : {}),
      version: { increment: 1 },
      updatedById: actor.userId,
      updatedByName: actor.email,
    };

    let updated: Prisma.BatchPayload;
    try {
      updated = await this.prisma.template.updateMany({
        where: {
          id: templateId,
          deletedAt: null,
          // Omitted means "I do not care what happened since I loaded this",
          // which is a real choice a recovery tool makes. The builder always
          // sends it.
          ...(dto.expectedVersion !== undefined ? { version: dto.expectedVersion } : {}),
        },
        data,
      });
    } catch (error) {
      throw this.translateDuplicateCode(error, code ?? existing.code);
    }

    if (updated.count === 0) {
      throw new StaleVersionError(
        'This template changed while you were editing it. Reload before saving again.',
        { details: { templateId, expectedVersion: dto.expectedVersion, actual: existing.version } },
      );
    }

    await this.audit.record({
      action: AuditAction.TEMPLATE_UPDATED,
      entityType: 'TEMPLATE',
      entityId: templateId,
      entityName: `${existing.code} — ${existing.name}`,
      accountId: actor.accountId,
      // The design document is deliberately not logged: it is the whole
      // artwork, it changes on every autosave, and an audit table that carried
      // a copy of every keystroke's document would dwarf the tables it records.
      details: {
        changed: Object.keys(dto).filter((key) => key !== 'expectedVersion'),
        fromVersion: existing.version,
      },
    });

    return this.findById(actor, templateId);
  }

  /**
   * Publishes: freezes the current draft as a version and points the storefront
   * at it.
   *
   * Republishing an already-published template is the same operation — it cuts
   * a new version and moves the pointer. That is why publishing is its own
   * endpoint rather than a status change: `PUBLISHED → PUBLISHED` is not a
   * transition, but it is a thing a designer does every week.
   */
  async publish(
    templateId: string,
    dto: PublishTemplateDto,
    actor: AuthenticatedActor,
  ): Promise<FullTemplateSource> {
    const existing = await this.requireManageable(actor, templateId);

    assertPublishable({ name: existing.name, layers: readLayers(existing.layers) });

    await this.prisma.$transaction(async (tx) => {
      // Re-read inside the transaction. Between the checks above and this
      // write another save may have landed, and the snapshot has to be of what
      // is actually there — publishing a version numbered for one document and
      // holding another is the one corruption this table cannot recover from.
      const current = await tx.template.findUniqueOrThrow({ where: { id: templateId } });
      assertPublishable({ name: current.name, layers: readLayers(current.layers) });

      const version = await tx.templateVersion.create({
        data: {
          id: createId('tpv'),
          templateId,
          version: current.version,
          snapshot: this.buildSnapshot(current) as unknown as Prisma.InputJsonValue,
          label: dto.label ?? 'Published',
          createdById: actor.userId,
          createdByName: actor.email,
        },
      });

      await tx.template.update({
        where: { id: templateId },
        data: {
          status: 'PUBLISHED',
          publishedVersionId: version.id,
          publishedAt: new Date(),
          updatedById: actor.userId,
          updatedByName: actor.email,
        },
      });
    });

    await this.audit.record({
      action: AuditAction.TEMPLATE_PUBLISHED,
      entityType: 'TEMPLATE',
      entityId: templateId,
      entityName: `${existing.code} — ${existing.name}`,
      accountId: actor.accountId,
      details: { version: existing.version, label: dto.label ?? 'Published' },
    });

    return this.findById(actor, templateId);
  }

  /**
   * Moves between DRAFT, PUBLISHED and ARCHIVED.
   *
   * Publishing is *not* reachable here: it has to cut a version, and a status
   * change that silently did that would hide the one act with a lasting
   * consequence behind the one without. `changeStatus` to PUBLISHED is refused
   * with a message pointing at `publish`.
   */
  async changeStatus(
    templateId: string,
    dto: ChangeTemplateStatusDto,
    actor: AuthenticatedActor,
  ): Promise<FullTemplateSource> {
    const existing = await this.requireManageable(actor, templateId);

    if (dto.status === 'PUBLISHED') {
      throw new BusinessRuleError(
        'Use POST /templates/:id/publish to publish. Publishing freezes a version, ' +
          'which a status change would hide.',
      );
    }

    assertTransition(existing.status, dto.status);

    await this.prisma.template.update({
      where: { id: templateId },
      data: {
        status: dto.status,
        // The published pointer is deliberately kept when archiving or
        // unpublishing: an order personalised from a version must still
        // resolve it, and clearing the pointer would strand exactly the
        // customers who already committed.
        updatedById: actor.userId,
        updatedByName: actor.email,
      },
    });

    await this.audit.record({
      action: AuditAction.TEMPLATE_STATUS_CHANGED,
      entityType: 'TEMPLATE',
      entityId: templateId,
      entityName: `${existing.code} — ${existing.name}`,
      accountId: actor.accountId,
      details: { from: existing.status, to: dto.status },
    });

    return this.findById(actor, templateId);
  }

  /**
   * Copies an old version back over the draft.
   *
   * Never deletes the versions in between — the point of a history is that it
   * does not lose the thing you restored *from*. The restore is itself a save,
   * so it bumps `version` and can be undone by restoring the version it
   * replaced.
   */
  async restoreVersion(
    templateId: string,
    dto: RestoreVersionDto,
    actor: AuthenticatedActor,
  ): Promise<FullTemplateSource> {
    const existing = await this.requireManageable(actor, templateId);

    const version = await this.prisma.templateVersion.findUnique({
      where: { templateId_version: { templateId, version: dto.version } },
    });

    if (!version) {
      throw new NotFoundError(`This template has no version ${dto.version}.`, {
        details: { templateId, version: dto.version },
      });
    }

    const snapshot = readSnapshot(version.snapshot);

    await this.prisma.template.update({
      where: { id: templateId },
      data: {
        name: snapshot.name,
        description: snapshot.description,
        theme: snapshot.theme,
        orientation: snapshot.orientation,
        aspectRatio: snapshot.aspectRatio,
        widthValue: new Prisma.Decimal(snapshot.widthValue),
        heightValue: new Prisma.Decimal(snapshot.heightValue),
        dimensionUnit: snapshot.dimensionUnit,
        bleedMargin: new Prisma.Decimal(snapshot.bleedMargin),
        safeMargin: new Prisma.Decimal(snapshot.safeMargin),
        canvasConfig: snapshot.canvasConfig as Prisma.InputJsonValue,
        layers: snapshot.layers as unknown as Prisma.InputJsonValue,
        design: (snapshot.design ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        canvasJson: snapshot.canvasJson,
        version: { increment: 1 },
        updatedById: actor.userId,
        updatedByName: actor.email,
      },
    });

    await this.audit.record({
      action: AuditAction.TEMPLATE_VERSION_RESTORED,
      entityType: 'TEMPLATE',
      entityId: templateId,
      entityName: `${existing.code} — ${existing.name}`,
      accountId: actor.accountId,
      details: { restoredVersion: dto.version, overVersion: existing.version },
    });

    return this.findById(actor, templateId);
  }

  /**
   * Copies a template into a new draft.
   *
   * Version history and assets are *not* copied. The history belongs to the
   * original — a copy that claimed twelve prior versions it never had would
   * make the history lie — and the assets are files the copy would then share,
   * so deleting one template would break the other's tiles.
   */
  async duplicate(
    templateId: string,
    dto: DuplicateTemplateDto,
    actor: AuthenticatedActor,
  ): Promise<FullTemplateSource> {
    const source = await this.requireManageable(actor, templateId);

    const name = dto.name ?? `${source.name} (copy)`;
    const code = normaliseTemplateCode(dto.code ?? (await this.deriveCode(name)));
    const id = createId('tpl');

    try {
      await this.prisma.template.create({
        data: {
          id,
          code,
          name,
          description: source.description,
          productId: source.productId,
          categoryId: source.categoryId,
          // Always a draft, whatever the original was. A copy landing straight
          // on the storefront is how a half-edited duplicate reaches customers.
          status: 'DRAFT',
          visibility: source.visibility,
          theme: source.theme,
          orientation: source.orientation,
          aspectRatio: source.aspectRatio,
          widthValue: source.widthValue,
          heightValue: source.heightValue,
          dimensionUnit: source.dimensionUnit,
          bleedMargin: source.bleedMargin,
          safeMargin: source.safeMargin,
          canvasConfig: source.canvasConfig as Prisma.InputJsonValue,
          layers: source.layers as Prisma.InputJsonValue,
          design: (source.design ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          canvasJson: source.canvasJson,
          createdById: actor.userId,
          createdByName: actor.email,
          updatedById: actor.userId,
          updatedByName: actor.email,
        },
      });
    } catch (error) {
      throw this.translateDuplicateCode(error, code);
    }

    await this.audit.record({
      action: AuditAction.TEMPLATE_DUPLICATED,
      entityType: 'TEMPLATE',
      entityId: id,
      entityName: `${code} — ${name}`,
      accountId: actor.accountId,
      details: { copiedFrom: templateId, copiedFromCode: source.code },
    });

    return this.findById(actor, id);
  }

  /**
   * Soft delete.
   *
   * The row survives because published versions of it may be referenced by
   * orders. What stops is every read: `deletedAt: null` is in the filter of
   * each one, so a deleted template disappears from the gallery and from the
   * customiser immediately.
   */
  async remove(templateId: string, actor: AuthenticatedActor): Promise<void> {
    const existing = await this.requireManageable(actor, templateId);

    await this.prisma.template.update({
      where: { id: templateId },
      data: { deletedAt: new Date(), status: 'ARCHIVED' },
    });

    await this.audit.record({
      action: AuditAction.TEMPLATE_DELETED,
      entityType: 'TEMPLATE',
      entityId: templateId,
      entityName: `${existing.code} — ${existing.name}`,
      accountId: actor.accountId,
      details: { code: existing.code },
    });
  }

  async setVisibility(
    templateId: string,
    dto: SetTemplateVisibilityDto,
    actor: AuthenticatedActor,
  ): Promise<FullTemplateSource> {
    const existing = await this.requireManageable(actor, templateId);

    if (dto.visibility === 'RESTRICTED') {
      const found = await this.prisma.account.count({
        where: { id: { in: dto.accountIds }, deletedAt: null },
      });
      if (found !== new Set(dto.accountIds).size) {
        throw new BusinessRuleError(
          'One or more of those accounts does not exist. Nothing was changed.',
        );
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.template.update({
        where: { id: templateId },
        data: { visibility: dto.visibility },
      });

      // Replaced wholesale rather than diffed. The list is short, the operation
      // is rare, and a diff is a place for a stale grant to survive.
      await tx.templateAccountVisibility.deleteMany({ where: { templateId } });

      if (dto.visibility === 'RESTRICTED') {
        await tx.templateAccountVisibility.createMany({
          data: [...new Set(dto.accountIds)].map((accountId) => ({
            id: createId('tav'),
            templateId,
            accountId,
          })),
        });
      }
    });

    await this.audit.record({
      action: AuditAction.TEMPLATE_VISIBILITY_SET,
      entityType: 'TEMPLATE',
      entityId: templateId,
      entityName: `${existing.code} — ${existing.name}`,
      accountId: actor.accountId,
      details: { visibility: dto.visibility, accountCount: dto.accountIds.length },
    });

    return this.findById(actor, templateId);
  }

  // --- Assets --------------------------------------------------------------------

  /**
   * Step one of the upload: where to put the file.
   *
   * The template's code is in the key so an object's owner is readable from the
   * key alone in a console or an access log. Templates are the operator's, not
   * a tenant's, so nothing here is filed per account.
   */
  async presignAssetUpload(
    templateId: string,
    dto: PresignTemplateAssetDto,
    actor: AuthenticatedActor,
  ): Promise<{ uploadUrl: string; storageKey: string }> {
    const template = await this.requireManageable(actor, templateId);

    const storageKey = this.storage.buildKey(
      StoragePrefix.ARTWORK,
      `template/${template.code}`,
      `${Date.now()}-${dto.filename}`,
    );

    const uploadUrl = await this.storage.presignUpload(storageKey, dto.contentType);

    return { uploadUrl, storageKey };
  }

  /**
   * Step two: register the uploaded file.
   *
   * Three things happen here that each close a specific hole:
   *
   * 1. The object is confirmed to exist. Otherwise a failed upload leaves a row
   *    claiming success and a listing renders a broken tile with nothing to say
   *    why.
   * 2. The key is confirmed to belong to *this* template's prefix. A client
   *    could otherwise attach another template's file — or any object in the
   *    bucket it could name — to a template it can edit.
   * 3. A THUMBNAIL or PREVIEW replaces the previous one rather than joining it,
   *    because both are singular by nature and the schema enforces that anyway.
   */
  async attachAsset(
    templateId: string,
    dto: AttachTemplateAssetDto,
    actor: AuthenticatedActor,
  ): Promise<FullTemplateSource> {
    const template = await this.requireManageable(actor, templateId);

    // Built by hand rather than through buildKey, which refuses an empty name:
    // this is a prefix, not a key. The code is already normalised to A-Z, 0-9
    // and hyphens, so there is nothing here to escape.
    const expectedPrefix = `${StoragePrefix.ARTWORK}/template/${template.code}/`;
    if (!dto.storageKey.startsWith(expectedPrefix)) {
      throw new BusinessRuleError(
        'That storage key does not belong to this template. Use the key the presign call returned.',
        { details: { storageKey: dto.storageKey } },
      );
    }

    if (!(await this.storage.exists(dto.storageKey))) {
      throw new BusinessRuleError(
        'No uploaded file was found at that key. Complete the upload before attaching it.',
        { details: { storageKey: dto.storageKey } },
      );
    }

    const assetId = createId('tpa');

    const previousSingleton =
      dto.kind === 'THUMBNAIL'
        ? template.thumbnailAssetId
        : dto.kind === 'PREVIEW'
          ? template.previewAssetId
          : null;

    await this.prisma.$transaction(async (tx) => {
      await tx.templateAsset.create({
        data: {
          id: assetId,
          templateId,
          kind: dto.kind,
          storageKey: dto.storageKey,
          filename: dto.filename,
          contentType: dto.contentType,
          sizeBytes: dto.sizeBytes,
          altText: dto.altText ?? null,
          sortOrder: dto.sortOrder,
          damDocumentId: dto.damDocumentId ?? null,
          // Set before the job is queued, so an enqueue failure leaves the
          // asset PENDING for a later sweep rather than stuck claiming it never
          // needed a thumbnail.
          derivativeStatus: dto.contentType.startsWith('image/') ? 'PENDING' : 'NOT_APPLICABLE',
        },
      });

      if (dto.kind === 'THUMBNAIL') {
        await tx.template.update({
          where: { id: templateId },
          data: { thumbnailAssetId: assetId },
        });
      } else if (dto.kind === 'PREVIEW') {
        await tx.template.update({
          where: { id: templateId },
          data: { previewAssetId: assetId },
        });
      }

      // The pointer moved first, so this delete cannot orphan a live reference.
      if (previousSingleton) {
        await tx.templateAsset.delete({ where: { id: previousSingleton } });
      }
    });

    if (dto.contentType.startsWith('image/')) {
      await this.derivatives.enqueue(assetId, 'TEMPLATE').catch((error: unknown) => {
        // A missing thumbnail is a slower gallery, not a failed upload. The
        // asset is already PENDING, which is what a sweep looks for.
        this.logger.warn(
          `Could not queue derivatives for template asset ${assetId}: ` +
            (error instanceof Error ? error.message : String(error)),
        );
      });
    }

    await this.audit.record({
      action: AuditAction.TEMPLATE_ASSET_ATTACHED,
      entityType: 'TEMPLATE',
      entityId: templateId,
      entityName: `${template.code} — ${template.name}`,
      accountId: actor.accountId,
      details: { assetId, kind: dto.kind, filename: dto.filename, replaced: previousSingleton },
    });

    return this.findById(actor, templateId);
  }

  async removeAsset(templateId: string, assetId: string, actor: AuthenticatedActor): Promise<void> {
    const template = await this.requireManageable(actor, templateId);

    const asset = await this.prisma.templateAsset.findFirst({
      where: { id: assetId, templateId },
    });
    if (!asset) {
      throw new NotFoundError('Asset not found on this template.', {
        details: { templateId, assetId },
      });
    }

    // The pointer is cleared first: deleting a row a template still points at
    // would fail the foreign key, and clearing it afterwards would leave a
    // window where the template references a deleted asset.
    await this.prisma.$transaction(async (tx) => {
      if (template.thumbnailAssetId === assetId) {
        await tx.template.update({ where: { id: templateId }, data: { thumbnailAssetId: null } });
      }
      if (template.previewAssetId === assetId) {
        await tx.template.update({ where: { id: templateId }, data: { previewAssetId: null } });
      }
      await tx.templateAsset.delete({ where: { id: assetId } });
    });

    // The object itself is left in storage. Removing it here would delete a
    // file that a published version's design may still reference, and storage
    // is cheap next to a template that renders with a hole in it. Sweeping
    // genuinely unreferenced objects belongs on the MAINTENANCE queue.
    await this.audit.record({
      action: AuditAction.TEMPLATE_ASSET_REMOVED,
      entityType: 'TEMPLATE',
      entityId: templateId,
      entityName: `${template.code} — ${template.name}`,
      accountId: actor.accountId,
      details: { assetId, kind: asset.kind, filename: asset.filename },
    });
  }

  // --- Personalisation -----------------------------------------------------------

  /**
   * Validates a buyer's personalisation against the template they are ordering
   * from, and returns only the values that template accepts.
   *
   * Checked against the **published version**, never the draft: the buyer is
   * looking at the published artwork, and validating against a draft the
   * designer has since changed would reject fields that are on their screen.
   */
  async customise(
    actor: AuthenticatedActor,
    templateId: string,
    dto: CustomiseTemplateDto,
  ): Promise<{
    templateId: string;
    versionId: string;
    version: number;
    fields: Record<string, string>;
  }> {
    const { version } = await this.getCustomisable(actor, templateId);
    const snapshot = readSnapshot(version.snapshot);

    const fields = acceptCustomisation(
      snapshot.layers as unknown as Parameters<typeof acceptCustomisation>[0],
      dto.fields,
    );

    return {
      templateId,
      versionId: version.id,
      version: version.version,
      fields,
    };
  }

  // --- Presigning ----------------------------------------------------------------

  /**
   * One signed tile per template, for a gallery.
   *
   * Falls back to the original when no derivative exists yet: a freshly
   * uploaded image whose resize is still queued should show the full-size file
   * rather than a broken tile.
   */
  async presignThumbnails(
    templates: readonly TemplateSummarySource[],
  ): Promise<Record<string, string>> {
    const withThumbnails = templates.filter((template) => template.thumbnailAssetId !== null);
    if (withThumbnails.length === 0) return {};

    const assets = await this.prisma.templateAsset.findMany({
      where: { id: { in: withThumbnails.map((template) => template.thumbnailAssetId!) } },
      select: { id: true, storageKey: true, thumbnailKey: true },
    });
    const byId = new Map(assets.map((asset) => [asset.id, asset]));

    const jobs = withThumbnails.flatMap((template) => {
      const asset = byId.get(template.thumbnailAssetId!);
      if (!asset) return [];

      return [
        this.storage
          .presignDownload(asset.thumbnailKey ?? asset.storageKey)
          .then((url) => [template.id, url] as const),
      ];
    });

    return Object.fromEntries(await Promise.all(jobs));
  }

  /** Every asset of one template, plus the two singleton shortcuts a view needs. */
  async presignAssets(template: FullTemplateSource): Promise<Record<string, string>> {
    const jobs = template.assets.flatMap((asset) => {
      const entries: Promise<readonly [string, string]>[] = [
        this.storage
          .presignDownload(asset.storageKey, asset.filename)
          .then((url) => [asset.id, url] as const),
      ];

      if (asset.thumbnailKey) {
        entries.push(
          this.storage
            .presignDownload(asset.thumbnailKey)
            .then((url) => [`${asset.id}:thumbnail`, url] as const),
        );
      }

      // Named aliases so a view can reach the tile and the mock-up without
      // knowing which asset id happens to be in the pointer today.
      if (asset.id === template.thumbnailAssetId) {
        entries.push(
          this.storage
            .presignDownload(asset.thumbnailKey ?? asset.storageKey)
            .then((url) => ['thumbnail', url] as const),
        );
      }
      if (asset.id === template.previewAssetId) {
        entries.push(
          this.storage
            .presignDownload(asset.previewKey ?? asset.storageKey)
            .then((url) => ['preview', url] as const),
        );
      }

      return entries;
    });

    return Object.fromEntries(await Promise.all(jobs));
  }

  /** The tile and mock-up for one template, for the buyer's customiser view. */
  async presignShowcase(template: Template): Promise<Record<string, string>> {
    const ids = [template.thumbnailAssetId, template.previewAssetId].filter(
      (id): id is string => id !== null,
    );
    if (ids.length === 0) return {};

    const assets = await this.prisma.templateAsset.findMany({ where: { id: { in: ids } } });

    const jobs = assets.map(async (asset) => {
      const alias = asset.id === template.thumbnailAssetId ? 'thumbnail' : 'preview';
      const key =
        alias === 'thumbnail'
          ? (asset.thumbnailKey ?? asset.storageKey)
          : (asset.previewKey ?? asset.storageKey);
      return [alias, await this.storage.presignDownload(key)] as const;
    });

    return Object.fromEntries(await Promise.all(jobs));
  }

  // --- Shared guards -------------------------------------------------------------

  /**
   * The row, or a 404, for someone who may edit it.
   *
   * Every write goes through here. Reads use `visibilityFilter`; writes need
   * more than visibility, and the permission on the route is only half of it —
   * a deleted template must be uneditable even by an administrator who still
   * has its id in a browser tab.
   */
  private async requireManageable(
    actor: AuthenticatedActor,
    templateId: string,
  ): Promise<Template> {
    void actor;

    const template = await this.prisma.template.findFirst({
      where: { id: templateId, deletedAt: null },
    });

    if (!template) throw new NotFoundError('Template not found.', { details: { templateId } });
    return template;
  }

  /**
   * Everything needed to render the template without reading the draft again.
   *
   * A copy rather than a reference — a reference is exactly what would let the
   * row move underneath a version that promised not to.
   */
  private buildSnapshot(template: Template): TemplateSnapshot {
    return {
      code: template.code,
      name: template.name,
      description: template.description,
      productId: template.productId,
      categoryId: template.categoryId,
      theme: template.theme,
      orientation: template.orientation,
      aspectRatio: template.aspectRatio,
      widthValue: template.widthValue.toNumber(),
      heightValue: template.heightValue.toNumber(),
      dimensionUnit: template.dimensionUnit,
      bleedMargin: template.bleedMargin.toNumber(),
      safeMargin: template.safeMargin.toNumber(),
      canvasConfig: template.canvasConfig as Record<string, unknown>,
      layers: template.layers as unknown as readonly Record<string, unknown>[],
      design: (template.design ?? null) as Record<string, unknown> | null,
      canvasJson: template.canvasJson,
    };
  }

  /**
   * A code from the name, with a numeric suffix if it is taken.
   *
   * The builder's "New template" button has a name and no code, and asking a
   * designer to invent a unique identifier before they can draw anything is a
   * step nobody wants. Bounded rather than looping for ever: after a hundred
   * collisions the name is the problem, not the suffix.
   */
  private async deriveCode(name: string): Promise<string> {
    const base =
      normaliseTemplateCode(name)
        .replace(/[^A-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'TEMPLATE';

    const taken = new Set(
      (
        await this.prisma.template.findMany({
          where: { code: { startsWith: base } },
          select: { code: true },
        })
      ).map((row) => row.code),
    );

    if (!taken.has(base)) return base;

    for (let suffix = 2; suffix <= 100; suffix += 1) {
      const candidate = `${base}-${suffix}`;
      if (!taken.has(candidate)) return candidate;
    }

    // Falls back to something certainly free rather than failing the create.
    return `${base}-${Date.now().toString(36).toUpperCase()}`;
  }

  /** A referenced product or category has to exist before a row points at it. */
  private async assertReferencesExist(productId?: string, categoryId?: string): Promise<void> {
    if (productId) {
      const product = await this.prisma.product.findFirst({
        where: { id: productId, deletedAt: null },
        select: { id: true },
      });
      if (!product) {
        throw new BusinessRuleError('That product does not exist.', { details: { productId } });
      }
    }

    if (categoryId) {
      const category = await this.prisma.productCategory.findUnique({
        where: { id: categoryId },
        select: { id: true },
      });
      if (!category) {
        throw new BusinessRuleError('That category does not exist.', { details: { categoryId } });
      }
    }
  }

  /**
   * Turns the unique-code violation into the 409 it is.
   *
   * Caught rather than pre-checked: a `findFirst` before the write leaves a
   * window in which another create takes the code, and the database is the only
   * place that can decide without one.
   */
  private translateDuplicateCode(error: unknown, code: string): unknown {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
      return error;
    }

    // `meta.target` is the column list, and Prisma types it as `unknown`: an
    // array for most drivers, a string for some. Stringifying it blind would
    // read "[object Object]" and quietly match nothing, turning a duplicate code
    // into an unexplained 500.
    const target = error.meta?.target;
    const columns = Array.isArray(target)
      ? target.map((column) => String(column))
      : typeof target === 'string'
        ? [target]
        : [];

    if (!columns.some((column) => column.includes('code'))) return error;

    return new ConflictError(`A template with the code "${code}" already exists.`, {
      details: { code },
    });
  }
}

export type { TemplateAsset };
