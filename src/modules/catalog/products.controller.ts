import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission, RequirePermissions, type AuthenticatedActor, type OffsetPage } from '@/common';
import { zodBody } from '@/common/pipes/zod-validation.pipe';
import { ApiZodBody } from '@/common/utils/swagger-zod';
import { CurrentUser } from '@/modules/auth';
import {
  AdjustStockSchema,
  AttachAssetSchema,
  ChangeProductStatusSchema,
  CreateProductSchema,
  CreateVariantSchema,
  ImportProductsSchema,
  ListImportJobsQuerySchema,
  ListProductsQuerySchema,
  PresignAssetUploadSchema,
  SetProductOptionsSchema,
  SetVisibilitySchema,
  SetVolumeTiersSchema,
  UpdateProductSchema,
  UpdateVariantSchema,
  type AdjustStockDto,
  type AttachAssetDto,
  type ChangeProductStatusDto,
  type CreateProductDto,
  type CreateVariantDto,
  type ImportProductsDto,
  type ListImportJobsQueryDto,
  type ListProductsQueryDto,
  type PresignAssetUploadDto,
  type SetProductOptionsDto,
  type SetVisibilityDto,
  type SetVolumeTiersDto,
  type UpdateProductDto,
  type UpdateVariantDto,
} from './dto/product.dto';
import {
  toImportJobView,
  toProductView,
  type ImportJobView,
  type ProductView,
} from './dto/product-response';
import { ProductImportService } from './product-import.service';
import { ProductsService } from './products.service';

@ApiTags('catalog')
@ApiBearerAuth('access-token')
@Controller('catalog/products')
export class ProductsController {
  constructor(
    private readonly products: ProductsService,
    private readonly importer: ProductImportService,
  ) {}

  // --- Reads ------------------------------------------------------------------

  @Get()
  @RequirePermissions(Permission.CATALOG_VIEW)
  @ApiOperation({
    summary: 'Browse the catalogue',
    description:
      'Scoped to what the caller may see: an administrator gets the whole catalogue including ' +
      'drafts, everyone else gets published products that are unrestricted or granted to their ' +
      'account. Asset URLs are omitted unless `withThumbnails` is set, which presigns one ' +
      'thumbnail per row; fetch a single product for links to every asset.',
  })
  async list(
    @CurrentUser() actor: AuthenticatedActor,
    @Query(zodBody(ListProductsQuerySchema)) query: ListProductsQueryDto,
  ): Promise<OffsetPage<ProductView>> {
    const page = await this.products.list(actor, query);
    const assetUrls = query.withThumbnails ? await this.products.presignThumbnails(page.items) : {};

    return { ...page, items: page.items.map((product) => toProductView(product, assetUrls)) };
  }

  @Get(':productId')
  @RequirePermissions(Permission.CATALOG_VIEW)
  @ApiOperation({
    summary: 'One product, with options, variants, volume pricing and asset links',
  })
  async findOne(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('productId') productId: string,
  ): Promise<ProductView> {
    const product = await this.products.findById(actor, productId);
    return toProductView(product, await this.products.presignAssets(product));
  }

  // --- Lifecycle ---------------------------------------------------------------

  @Post()
  @RequirePermissions(Permission.CATALOG_MANAGE)
  @ApiOperation({
    summary: 'Create a product',
    description:
      'Always created as DRAFT. Publishing is a separate transition so that the moment a ' +
      'product becomes orderable has its own audit entry.',
  })
  @ApiZodBody(CreateProductSchema, {
    example: {
      sku: 'POS-A2-GLOSS',
      name: 'A2 Poster — Gloss 170gsm',
      categoryId: 'cat_01j9x…',
      basePrice: '4.50',
      moq: 25,
      orderMultiple: 25,
      packSize: 1,
      uom: 'EACH',
      widthMm: 420,
      heightMm: 594,
      bleedMm: '3',
      safeMarginMm: '5',
      leadTimeDays: 3,
      tags: ['poster', 'in-store'],
    },
  })
  async create(
    @CurrentUser() actor: AuthenticatedActor,
    @Body(zodBody(CreateProductSchema)) body: CreateProductDto,
  ): Promise<ProductView> {
    return toProductView(await this.products.create(body, actor));
  }

  @Patch(':productId')
  @RequirePermissions(Permission.CATALOG_MANAGE)
  @ApiOperation({ summary: 'Update a product' })
  @ApiZodBody(UpdateProductSchema, { example: { basePrice: '4.95', leadTimeDays: 5 } })
  async update(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('productId') productId: string,
    @Body(zodBody(UpdateProductSchema)) body: UpdateProductDto,
  ): Promise<ProductView> {
    return toProductView(await this.products.update(productId, body, actor));
  }

  @Post(':productId/status')
  @RequirePermissions(Permission.CATALOG_MANAGE)
  @ApiOperation({
    summary: 'Publish, withdraw or supersede a product',
    description:
      'DRAFT to ACTIVE publishes it; ACTIVE and UNAVAILABLE move freely between each other; ' +
      'either can be SUPERSEDED, which requires naming the replacement and is terminal. A ' +
      'product never returns to DRAFT.',
  })
  @ApiZodBody(ChangeProductStatusSchema, {
    example: { status: 'SUPERSEDED', supersededById: 'prd_01j9x…', reason: 'Stock discontinued' },
  })
  async changeStatus(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('productId') productId: string,
    @Body(zodBody(ChangeProductStatusSchema)) body: ChangeProductStatusDto,
  ): Promise<ProductView> {
    return toProductView(await this.products.changeStatus(productId, body, actor));
  }

  @Delete(':productId')
  @HttpCode(204)
  @RequirePermissions(Permission.CATALOG_MANAGE)
  @ApiOperation({
    summary: 'Delete a draft product',
    description:
      'Only a draft can be deleted. A published product is referenced by orders and invoices — ' +
      'mark it unavailable or supersede it instead.',
  })
  async remove(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('productId') productId: string,
  ): Promise<void> {
    await this.products.remove(productId, actor);
  }

  // --- Options, variants, pricing ------------------------------------------------

  @Put(':productId/options')
  @RequirePermissions(Permission.CATALOG_MANAGE)
  @ApiOperation({
    summary: 'Replace the option set',
    description:
      'Sent whole rather than patched one option at a time, because options and variants have ' +
      'to agree. Refused if it would orphan an existing variant.',
  })
  @ApiZodBody(SetProductOptionsSchema, {
    example: {
      options: [
        { name: 'Size', values: ['A4', 'A3', 'A2'], sortOrder: 0 },
        { name: 'Finish', values: ['Gloss', 'Matte'], sortOrder: 1 },
      ],
    },
  })
  async setOptions(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('productId') productId: string,
    @Body(zodBody(SetProductOptionsSchema)) body: SetProductOptionsDto,
  ): Promise<ProductView> {
    return toProductView(await this.products.setOptions(productId, body, actor));
  }

  @Post(':productId/variants')
  @RequirePermissions(Permission.CATALOG_MANAGE)
  @ApiOperation({
    summary: 'Add a variant',
    description: 'Must choose a value for every option the product defines.',
  })
  @ApiZodBody(CreateVariantSchema, {
    example: {
      sku: 'POS-A2-GLOSS-MATTE',
      attributes: { Size: 'A2', Finish: 'Matte' },
      priceOverride: '5.25',
    },
  })
  async createVariant(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('productId') productId: string,
    @Body(zodBody(CreateVariantSchema)) body: CreateVariantDto,
  ): Promise<ProductView> {
    await this.products.createVariant(productId, body, actor);
    return toProductView(await this.products.findById(actor, productId));
  }

  @Patch(':productId/variants/:variantId')
  @RequirePermissions(Permission.CATALOG_MANAGE)
  @ApiOperation({ summary: 'Update a variant' })
  @ApiZodBody(UpdateVariantSchema, { example: { priceOverride: '5.50', status: 'ACTIVE' } })
  async updateVariant(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('productId') productId: string,
    @Param('variantId') variantId: string,
    @Body(zodBody(UpdateVariantSchema)) body: UpdateVariantDto,
  ): Promise<ProductView> {
    await this.products.updateVariant(productId, variantId, body, actor);
    return toProductView(await this.products.findById(actor, productId));
  }

  @Delete(':productId/variants/:variantId')
  @HttpCode(204)
  @RequirePermissions(Permission.CATALOG_MANAGE)
  @ApiOperation({
    summary: 'Retire a variant',
    description: 'Soft — order lines reference the variant SKU.',
  })
  async removeVariant(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('productId') productId: string,
    @Param('variantId') variantId: string,
  ): Promise<void> {
    await this.products.removeVariant(productId, variantId, actor);
  }

  @Put(':productId/volume-tiers')
  @RequirePermissions(Permission.PRICING_MANAGE)
  @ApiOperation({
    summary: 'Replace the volume-discount ladder',
    description:
      'Tiers are a percentage off the base price, so a price change carries through the whole ' +
      'ladder. Each tier must discount more than the one below it.',
  })
  @ApiZodBody(SetVolumeTiersSchema, {
    example: {
      tiers: [
        { minQuantity: 100, discountPercent: 5 },
        { minQuantity: 250, discountPercent: 10 },
        { minQuantity: 500, discountPercent: 17.5 },
      ],
    },
  })
  async setVolumeTiers(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('productId') productId: string,
    @Body(zodBody(SetVolumeTiersSchema)) body: SetVolumeTiersDto,
  ): Promise<ProductView> {
    return toProductView(await this.products.setVolumeTiers(productId, body, actor));
  }

  // --- Visibility, stock, assets --------------------------------------------------

  @Put(':productId/visibility')
  @RequirePermissions(Permission.CATALOG_MANAGE)
  @ApiOperation({
    summary: 'Set which accounts may see this product',
    description:
      'RESTRICTED replaces the whole allow-list. Switching back to ALL_ACCOUNTS leaves the list ' +
      'in place, because a restriction lifted for a campaign is usually reinstated.',
  })
  @ApiZodBody(SetVisibilitySchema, {
    example: { visibility: 'RESTRICTED', accountIds: ['acc_01j9x…'] },
  })
  async setVisibility(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('productId') productId: string,
    @Body(zodBody(SetVisibilitySchema)) body: SetVisibilityDto,
  ): Promise<ProductView> {
    return toProductView(await this.products.setVisibility(productId, body, actor));
  }

  @Post(':productId/stock')
  @RequirePermissions(Permission.INVENTORY_MANAGE)
  @ApiOperation({
    summary: 'Adjust stock',
    description:
      'A signed movement, never an absolute figure — two people counting the same shelf and ' +
      'both submitting "42" loses an adjustment; both submitting "+3" does not. A reason is ' +
      'required and lands in the audit trail.',
  })
  @ApiZodBody(AdjustStockSchema, {
    example: { delta: 250, reason: 'Delivery GRN-4471' },
  })
  async adjustStock(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('productId') productId: string,
    @Body(zodBody(AdjustStockSchema)) body: AdjustStockDto,
  ): Promise<{ productId: string; variantId?: string; stockOnHand: number }> {
    return this.products.adjustStock(productId, body, actor);
  }

  @Post(':productId/assets/presign')
  @RequirePermissions(Permission.CATALOG_MANAGE)
  @ApiOperation({
    summary: 'Get a presigned upload URL for a product asset',
    description:
      'Upload straight to storage with the returned URL, then register the file with ' +
      'POST /assets. Two steps rather than one multipart POST, because a print-resolution ' +
      'artwork file has no business passing through this process.',
  })
  @ApiZodBody(PresignAssetUploadSchema, {
    example: { filename: 'poster-a2-front.png', contentType: 'image/png', kind: 'IMAGE' },
  })
  async presignAsset(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('productId') productId: string,
    @Body(zodBody(PresignAssetUploadSchema)) body: PresignAssetUploadDto,
  ): Promise<{ uploadUrl: string; storageKey: string }> {
    return this.products.presignAssetUpload(productId, body, actor);
  }

  @Post(':productId/assets')
  @RequirePermissions(Permission.CATALOG_MANAGE)
  @ApiOperation({
    summary: 'Register an uploaded asset against the product',
    description: 'Verifies the object exists before recording it.',
  })
  @ApiZodBody(AttachAssetSchema, {
    example: {
      storageKey: 'artwork/catalog/POS-A2-GLOSS/1788330000-poster-a2-front.png',
      filename: 'poster-a2-front.png',
      contentType: 'image/png',
      sizeBytes: 482_133,
      kind: 'IMAGE',
      altText: 'A2 gloss poster, front',
    },
  })
  async attachAsset(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('productId') productId: string,
    @Body(zodBody(AttachAssetSchema)) body: AttachAssetDto,
  ): Promise<ProductView> {
    const product = await this.products.attachAsset(productId, body, actor);
    return toProductView(product, await this.products.presignAssets(product));
  }

  @Delete(':productId/assets/:assetId')
  @HttpCode(204)
  @RequirePermissions(Permission.CATALOG_MANAGE)
  @ApiOperation({ summary: 'Remove a product asset' })
  async removeAsset(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('productId') productId: string,
    @Param('assetId') assetId: string,
  ): Promise<void> {
    await this.products.removeAsset(productId, assetId, actor);
  }

  // --- Bulk import -----------------------------------------------------------------

  @Post('import')
  @HttpCode(202)
  @RequirePermissions(Permission.CATALOG_MANAGE)
  @ApiOperation({
    summary: 'Queue a bulk create or update',
    description:
      'Answers 202 with a job to poll. The rows are stored and the work happens on the ' +
      '`import` queue, because a ten-thousand-row load has no business holding a request open. ' +
      'Rows are applied individually, so one bad row does not reject the file. Existing SKUs ' +
      'are skipped unless `updateExisting` is set. `dryRun` runs the same code without writing. ' +
      'Imported products land as DRAFT.',
  })
  @ApiZodBody(ImportProductsSchema, {
    example: {
      updateExisting: false,
      dryRun: true,
      rows: [
        {
          sku: 'FLY-A5-DL',
          name: 'A5 Flyer — 130gsm',
          categoryCode: 'FLYERS',
          basePrice: '0.32',
          moq: 500,
          orderMultiple: 500,
          uom: 'EACH',
          widthMm: 148,
          heightMm: 210,
          bleedMm: '3',
          tags: 'promo|seasonal',
        },
      ],
    },
  })
  async import(
    @CurrentUser() actor: AuthenticatedActor,
    @Body(zodBody(ImportProductsSchema)) body: ImportProductsDto,
  ): Promise<ImportJobView> {
    return toImportJobView(await this.importer.enqueue(body, actor));
  }

  @Get('import/jobs')
  @RequirePermissions(Permission.CATALOG_MANAGE)
  @ApiOperation({
    summary: 'Recent import runs, newest first',
    description: 'Without the submitted rows or the per-row results — fetch one job for those.',
  })
  async listImports(
    @CurrentUser() actor: AuthenticatedActor,
    @Query(zodBody(ListImportJobsQuerySchema)) query: ListImportJobsQueryDto,
  ): Promise<OffsetPage<ImportJobView>> {
    const page = await this.importer.listJobs(actor.accountId, query);
    return { ...page, items: page.items.map((job) => toImportJobView(job)) };
  }

  @Get('import/jobs/:jobId')
  @RequirePermissions(Permission.CATALOG_MANAGE)
  @ApiOperation({
    summary: 'Poll one import run',
    description:
      'QUEUED and RUNNING mean it is still going. COMPLETED means it finished — individual ' +
      'rows may still have failed, so read the counts. FAILED means the run itself broke and ' +
      '`error` says why. Includes the per-row results.',
  })
  async findImport(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('jobId') jobId: string,
  ): Promise<ImportJobView> {
    return toImportJobView(await this.importer.findJob(actor.accountId, jobId), true);
  }
}
