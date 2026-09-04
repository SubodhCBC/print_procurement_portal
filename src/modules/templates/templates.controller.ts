import { Body, Controller, Delete, Get, HttpCode, Param, Post, Patch, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission, RequirePermissions, type AuthenticatedActor } from '@/common';
import { ApiZodBody } from '@/common/utils/swagger-zod';
import { zodBody } from '@/common/pipes/zod-validation.pipe';
import { CurrentUser } from '@/modules/auth';
import { TemplatesService } from './templates.service';
import {
  AttachTemplateAssetSchema,
  ChangeTemplateStatusSchema,
  CreateTemplateSchema,
  CustomiseTemplateSchema,
  DuplicateTemplateSchema,
  ListTemplatesQuerySchema,
  PresignTemplateAssetSchema,
  PublishTemplateSchema,
  RestoreVersionSchema,
  SetTemplateVisibilitySchema,
  SnapshotTemplateSchema,
  UpdateTemplateSchema,
  type AttachTemplateAssetDto,
  type ChangeTemplateStatusDto,
  type CreateTemplateDto,
  type CustomiseTemplateDto,
  type DuplicateTemplateDto,
  type ListTemplatesQueryDto,
  type PresignTemplateAssetDto,
  type PublishTemplateDto,
  type RestoreVersionDto,
  type SetTemplateVisibilityDto,
  type SnapshotTemplateDto,
  type UpdateTemplateDto,
} from './dto/template.dto';
import {
  toCustomisableView,
  toTemplateDetail,
  toTemplateSummary,
  toVersionView,
  type CustomisableTemplateView,
  type TemplateDetailView,
  type TemplateSummaryView,
  type TemplateVersionView,
} from './dto/template-response';
import type { OffsetPage } from '@/common';

/**
 * Master artwork templates (SOW FE-13).
 *
 * ---------------------------------------------------------------------------
 * Two permissions, and the line between them is the product
 * ---------------------------------------------------------------------------
 * `TEMPLATE_MANAGE` — create, edit and publish master templates. Administrator
 * only; it is in no customer role, exactly like CATALOG_MANAGE and
 * PRICING_MANAGE, because the template library is the platform operator's.
 *
 * `TEMPLATE_USE` — read a published template and personalise it. Held by site
 * users and head office.
 *
 * That split *is* the feature the client asked for: an admin designs, everyone
 * else fills in the boxes the admin left open. It is enforced twice — by the
 * permission on the route, and by `acceptCustomisation`, which rebuilds a
 * buyer's submission from the published layers so a value aimed at a locked
 * layer cannot survive.
 */
@ApiTags('templates')
@ApiBearerAuth('access-token')
@Controller('templates')
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  // --- Reading -------------------------------------------------------------------

  @Get()
  @RequirePermissions(Permission.TEMPLATE_USE)
  @ApiOperation({
    summary: 'List templates',
    description:
      'An administrator sees the whole library including drafts. Everybody else sees published ' +
      'templates that are either unrestricted or granted to their account — a customer asking ' +
      'for `status=DRAFT` gets an empty page rather than an error, which is the visibility ' +
      'filter working rather than a fault.\n\n' +
      'Pass `withThumbnails=true` for a gallery. It is off by default because signing an image ' +
      'for a caller that only needs names is work for nobody.',
  })
  async list(
    @CurrentUser() actor: AuthenticatedActor,
    @Query(zodBody(ListTemplatesQuerySchema)) query: ListTemplatesQueryDto,
  ): Promise<OffsetPage<TemplateSummaryView>> {
    const page = await this.templates.list(actor, query);
    const thumbnails = query.withThumbnails
      ? await this.templates.presignThumbnails(page.items)
      : {};

    return {
      ...page,
      items: page.items.map((template) => toTemplateSummary(template, thumbnails[template.id])),
    };
  }

  @Get(':templateId')
  @RequirePermissions(Permission.TEMPLATE_USE)
  @ApiOperation({
    summary: 'The working copy of one template',
    description:
      'What the builder opens: the draft, its design document, its assets and its version ' +
      'history.\n\n' +
      'This is **not** what a buyer personalises — see `GET /:templateId/customise`, which ' +
      'returns the published snapshot instead. A designer mid-rework must not change the ' +
      'artwork somebody is halfway through ordering.',
  })
  async findOne(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('templateId') templateId: string,
  ): Promise<TemplateDetailView> {
    const template = await this.templates.findById(actor, templateId);
    return toTemplateDetail(template, await this.templates.presignAssets(template));
  }

  @Get(':templateId/versions')
  @RequirePermissions(Permission.TEMPLATE_MANAGE)
  @ApiOperation({
    summary: 'The version history',
    description:
      'Every published snapshot, newest first. Restoring one copies it back over the draft ' +
      'without deleting anything in between — the point of a history is that it does not lose ' +
      'the thing you restored from.',
  })
  async versions(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('templateId') templateId: string,
  ): Promise<readonly TemplateVersionView[]> {
    const [template, versions] = await Promise.all([
      this.templates.findById(actor, templateId),
      this.templates.listVersions(actor, templateId),
    ]);

    return versions.map((version) => toVersionView(version, template.publishedVersionId));
  }

  // --- Authoring -----------------------------------------------------------------

  @Post()
  @RequirePermissions(Permission.TEMPLATE_MANAGE)
  @ApiOperation({
    summary: 'Create a template',
    description:
      'Starts as a DRAFT and is invisible to customers until it is published. `code` is ' +
      'generated from the name when omitted, because asking a designer to invent a unique ' +
      'identifier before they can draw anything is a step nobody wants.',
  })
  @ApiZodBody(CreateTemplateSchema, {
    example: {
      name: 'Pharmacy Opening Hours A2',
      productId: 'prd_01hy...',
      orientation: 'PORTRAIT',
      widthValue: 16.5,
      heightValue: 23.4,
      dimensionUnit: 'IN',
      bleedMargin: 0.125,
      safeMargin: 0.25,
      canvasConfig: { backgroundColor: '#FFFFFF' },
      layers: [
        {
          id: 'layer-business-name',
          type: 'text',
          name: 'Business name',
          label: 'Your branch name',
          isEditableBySiteUser: true,
          fieldKey: 'businessName',
          isRequired: true,
          content: 'Apex Midtown Pharmacy',
        },
      ],
    },
  })
  async create(
    @CurrentUser() actor: AuthenticatedActor,
    @Body(zodBody(CreateTemplateSchema)) body: CreateTemplateDto,
  ): Promise<TemplateDetailView> {
    const template = await this.templates.create(body, actor);
    return toTemplateDetail(template, await this.templates.presignAssets(template));
  }

  @Patch(':templateId')
  @RequirePermissions(Permission.TEMPLATE_MANAGE)
  @ApiOperation({
    summary: 'Save a template — including an autosave',
    description:
      'Send only what changed. Every save bumps `version`.\n\n' +
      '`expectedVersion` is the version the editor believes it is editing. When it is supplied ' +
      'and no longer matches, the save is refused with **409** rather than applied: two ' +
      'designers with one template open is an ordinary Tuesday, and silently keeping whichever ' +
      "save landed last is how an afternoon's work disappears with nothing to show it existed. " +
      'The comparison happens inside the write, not before it, so there is no window between ' +
      'the check and the save for the collision to slip through.\n\n' +
      'Saving does **not** change what customers see. That is `POST /:templateId/publish`.',
  })
  @ApiZodBody(UpdateTemplateSchema, {
    example: { canvasJson: '{"objects":[]}', expectedVersion: 4 },
  })
  async update(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('templateId') templateId: string,
    @Body(zodBody(UpdateTemplateSchema)) body: UpdateTemplateDto,
  ): Promise<TemplateDetailView> {
    const template = await this.templates.update(templateId, body, actor);
    return toTemplateDetail(template, await this.templates.presignAssets(template));
  }

  @Post(':templateId/publish')
  @RequirePermissions(Permission.TEMPLATE_MANAGE)
  @ApiOperation({
    summary: 'Publish the current draft',
    description:
      'Freezes the draft as an immutable version and points the storefront at it.\n\n' +
      'Republishing an already-published template is the same call: it cuts a new version and ' +
      'moves the pointer. That is why publishing is its own endpoint rather than a status ' +
      'change — `PUBLISHED → PUBLISHED` is not a transition, but it is a thing a designer does ' +
      'every week.',
  })
  @ApiZodBody(PublishTemplateSchema, { example: { label: 'Q4 rebrand' } })
  async publish(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('templateId') templateId: string,
    @Body(zodBody(PublishTemplateSchema)) body: PublishTemplateDto,
  ): Promise<TemplateDetailView> {
    const template = await this.templates.publish(templateId, body, actor);
    return toTemplateDetail(template, await this.templates.presignAssets(template));
  }

  @Post(':templateId/status')
  @RequirePermissions(Permission.TEMPLATE_MANAGE)
  @ApiOperation({
    summary: 'Unpublish or archive',
    description:
      'DRAFT ⇄ PUBLISHED ⇄ ARCHIVED, and ARCHIVED back to DRAFT. Restoring lands in DRAFT ' +
      'rather than straight on the storefront, so somebody looks at it before customers do.\n\n' +
      'Publishing is refused here and pointed at `/publish`, because it has to cut a version ' +
      'and a status change that silently did that would hide the one act with a lasting ' +
      'consequence behind the one without.\n\n' +
      'Unpublishing keeps the published pointer: an order personalised from a version must ' +
      'still resolve it.',
  })
  @ApiZodBody(ChangeTemplateStatusSchema, { example: { status: 'ARCHIVED' } })
  async changeStatus(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('templateId') templateId: string,
    @Body(zodBody(ChangeTemplateStatusSchema)) body: ChangeTemplateStatusDto,
  ): Promise<TemplateDetailView> {
    const template = await this.templates.changeStatus(templateId, body, actor);
    return toTemplateDetail(template, await this.templates.presignAssets(template));
  }

  @Post(':templateId/versions')
  @RequirePermissions(Permission.TEMPLATE_MANAGE)
  @ApiOperation({
    summary: 'Cut a restore point without publishing',
    description:
      'What the builder calls on an explicit save — as opposed to an autosave — because an ' +
      'explicit save is the moment a designer decided something was worth keeping.\n\n' +
      'Uses the version number the draft is already on, so "restore version 7" means the same ' +
      'thing whether 7 was published or merely kept. Snapshotting twice at the same version is ' +
      'a no-op: a save that changed nothing should not fail, and has nothing new to record.\n\n' +
      'Returns the whole history, so the panel that triggered it can render without a second ' +
      'round trip.',
  })
  @ApiZodBody(SnapshotTemplateSchema, { example: { label: 'Before the copy rewrite' } })
  async snapshot(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('templateId') templateId: string,
    @Body(zodBody(SnapshotTemplateSchema)) body: SnapshotTemplateDto,
  ): Promise<readonly TemplateVersionView[]> {
    const [template, versions] = await Promise.all([
      this.templates.findById(actor, templateId),
      this.templates.snapshot(templateId, body, actor),
    ]);

    return versions.map((version) => toVersionView(version, template.publishedVersionId));
  }

  @Post(':templateId/versions/restore')
  @RequirePermissions(Permission.TEMPLATE_MANAGE)
  @ApiOperation({
    summary: 'Copy an old version back over the draft',
    description:
      'Restoring is itself a save: it bumps `version` and can be undone by restoring the ' +
      'version it replaced. It publishes nothing — the storefront keeps rendering whatever it ' +
      'was rendering until somebody publishes deliberately.',
  })
  @ApiZodBody(RestoreVersionSchema, { example: { version: 3 } })
  async restoreVersion(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('templateId') templateId: string,
    @Body(zodBody(RestoreVersionSchema)) body: RestoreVersionDto,
  ): Promise<TemplateDetailView> {
    const template = await this.templates.restoreVersion(templateId, body, actor);
    return toTemplateDetail(template, await this.templates.presignAssets(template));
  }

  @Post(':templateId/duplicate')
  @RequirePermissions(Permission.TEMPLATE_MANAGE)
  @ApiOperation({
    summary: 'Copy a template into a new draft',
    description:
      'The copy is always a DRAFT, whatever the original was — a duplicate landing straight on ' +
      'the storefront is how a half-edited copy reaches customers.\n\n' +
      'Version history and assets are not copied: the history belongs to the original, and ' +
      'shared asset rows would mean deleting one template broke the other’s tiles.',
  })
  @ApiZodBody(DuplicateTemplateSchema, { example: { name: 'Pharmacy Opening Hours A3' } })
  async duplicate(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('templateId') templateId: string,
    @Body(zodBody(DuplicateTemplateSchema)) body: DuplicateTemplateDto,
  ): Promise<TemplateDetailView> {
    const template = await this.templates.duplicate(templateId, body, actor);
    return toTemplateDetail(template, await this.templates.presignAssets(template));
  }

  @Post(':templateId/visibility')
  @RequirePermissions(Permission.TEMPLATE_MANAGE)
  @ApiOperation({
    summary: 'Restrict a template to named accounts',
    description:
      'ALL_ACCOUNTS or RESTRICTED, mirroring the catalogue. The account list is replaced ' +
      'wholesale rather than diffed — it is short, the operation is rare, and a diff is a ' +
      'place for a stale grant to survive.',
  })
  @ApiZodBody(SetTemplateVisibilitySchema, {
    example: { visibility: 'RESTRICTED', accountIds: ['acc_01hy...'] },
  })
  async setVisibility(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('templateId') templateId: string,
    @Body(zodBody(SetTemplateVisibilitySchema)) body: SetTemplateVisibilityDto,
  ): Promise<TemplateDetailView> {
    const template = await this.templates.setVisibility(templateId, body, actor);
    return toTemplateDetail(template, await this.templates.presignAssets(template));
  }

  @Delete(':templateId')
  @HttpCode(204)
  @RequirePermissions(Permission.TEMPLATE_MANAGE)
  @ApiOperation({
    summary: 'Delete a template',
    description:
      'A soft delete. The row survives because published versions of it may be referenced by ' +
      'orders, but every read filters it out, so it disappears from the gallery and the ' +
      'customiser immediately.',
  })
  async remove(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('templateId') templateId: string,
  ): Promise<void> {
    await this.templates.remove(templateId, actor);
  }

  // --- Assets --------------------------------------------------------------------

  @Post(':templateId/assets/presign')
  @RequirePermissions(Permission.TEMPLATE_MANAGE)
  @ApiOperation({
    summary: 'Get a presigned upload URL for a thumbnail, cover or source image',
    description:
      'Upload straight to storage with the returned URL, then register the file with ' +
      '`POST /:templateId/assets` using the `storageKey` this call handed back.\n\n' +
      'Two steps rather than one multipart POST: a cover image has no business passing through ' +
      'this process, and a half-finished upload leaves no row behind claiming it succeeded.\n\n' +
      'Images only. A presigned URL is a bearer token for a write, and signing one for an ' +
      'arbitrary content type would turn this into "upload anything to our bucket".',
  })
  @ApiZodBody(PresignTemplateAssetSchema, {
    example: { filename: 'opening-hours-tile.png', contentType: 'image/png', kind: 'THUMBNAIL' },
  })
  async presignAsset(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('templateId') templateId: string,
    @Body(zodBody(PresignTemplateAssetSchema)) body: PresignTemplateAssetDto,
  ): Promise<{ uploadUrl: string; storageKey: string }> {
    return this.templates.presignAssetUpload(templateId, body, actor);
  }

  @Post(':templateId/assets')
  @RequirePermissions(Permission.TEMPLATE_MANAGE)
  @ApiOperation({
    summary: 'Register an uploaded image against the template',
    description:
      'Verifies three things before a row claims a file exists: that the object is really ' +
      'there, that its key belongs to *this* template’s prefix — otherwise a client could ' +
      'attach any object in the bucket it could name — and, for THUMBNAIL and PREVIEW, that ' +
      'the previous one is replaced rather than joined, because both are singular by nature.\n\n' +
      'Resized copies are generated on the render queue. A tile that is a 12MB PNG scaled down ' +
      'in the browser is how a gallery of forty templates becomes unusable on a laptop.',
  })
  @ApiZodBody(AttachTemplateAssetSchema, {
    example: {
      storageKey: 'artwork/template/PHARMACY-HOURS-A2/1788330000-tile.png',
      filename: 'tile.png',
      contentType: 'image/png',
      sizeBytes: 184_221,
      kind: 'THUMBNAIL',
      altText: 'Opening hours poster, A2',
    },
  })
  async attachAsset(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('templateId') templateId: string,
    @Body(zodBody(AttachTemplateAssetSchema)) body: AttachTemplateAssetDto,
  ): Promise<TemplateDetailView> {
    const template = await this.templates.attachAsset(templateId, body, actor);
    return toTemplateDetail(template, await this.templates.presignAssets(template));
  }

  @Delete(':templateId/assets/:assetId')
  @HttpCode(204)
  @RequirePermissions(Permission.TEMPLATE_MANAGE)
  @ApiOperation({
    summary: 'Remove a template asset',
    description:
      'The stored object is left in place. A published version’s design may still reference ' +
      'it, and storage is cheap next to a template that renders with a hole in it.',
  })
  async removeAsset(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('templateId') templateId: string,
    @Param('assetId') assetId: string,
  ): Promise<void> {
    await this.templates.removeAsset(templateId, assetId, actor);
  }

  // --- Personalisation -----------------------------------------------------------

  @Get(':templateId/customise')
  @RequirePermissions(Permission.TEMPLATE_USE)
  @ApiOperation({
    summary: 'The published artwork a buyer personalises',
    description:
      'Returns the **published snapshot**, never the working copy — so a designer mid-rework ' +
      'cannot change what somebody is halfway through ordering.\n\n' +
      '`fields` is the list of boxes this buyer may fill in, derived from the layers the ' +
      'designer marked editable. Everything else in `layers` is locked and is sent only so the ' +
      'customiser can draw the artwork around those boxes.',
  })
  async customisable(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('templateId') templateId: string,
  ): Promise<CustomisableTemplateView> {
    const { template, version } = await this.templates.getCustomisable(actor, templateId);
    return toCustomisableView(template, version, await this.templates.presignShowcase(template));
  }

  @Post(':templateId/customise')
  @HttpCode(200)
  @RequirePermissions(Permission.TEMPLATE_USE)
  @ApiOperation({
    summary: 'Check a personalisation before it goes in the basket',
    description:
      'Validates the submitted values against the published template and returns the accepted ' +
      'set, together with the version they were checked against — which is what a cart line ' +
      'stores, so the basket records the artwork the buyer actually saw.\n\n' +
      'A value aimed at a layer the designer locked is **refused**, not dropped: silently ' +
      'discarding it is a buyer who thinks they set their phone number and receives five ' +
      'hundred flyers without it. Unknown keys are refused for the same reason.',
  })
  @ApiZodBody(CustomiseTemplateSchema, {
    example: { fields: { businessName: 'Apex Midtown Pharmacy', phone: '+61 3 9000 0000' } },
  })
  async customise(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('templateId') templateId: string,
    @Body(zodBody(CustomiseTemplateSchema)) body: CustomiseTemplateDto,
  ): Promise<{
    templateId: string;
    versionId: string;
    version: number;
    fields: Record<string, string>;
  }> {
    return this.templates.customise(actor, templateId, body);
  }
}
