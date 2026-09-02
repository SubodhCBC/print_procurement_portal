import { Injectable, Logger } from '@nestjs/common';
import type { Prisma, ProductCategory } from '@prisma/client';
import { BusinessRuleError, ConflictError, createId, NotFoundError } from '@/common';
import { PrismaService } from '@/database';
import { AuditAction, AuditService } from '@/modules/audit';
import type {
  CreateCategoryDto,
  ListCategoriesQueryDto,
  UpdateCategoryDto,
} from './dto/category.dto';

export type CategoryWithCount = ProductCategory & { _count: { products: number } };

/**
 * The catalog's category taxonomy.
 *
 * Global, like the rest of the catalog: no `accountId`, no tenant scope, no RLS
 * policy. `CATALOG_MANAGE` is what protects it, and only ADMIN holds that.
 *
 * Every read here is unpaginated. There are eight categories in the statement
 * of work, and paginating a list the navigation renders in full would be
 * ceremony — the cap in `list()` is there to keep that assumption honest rather
 * than to page through anything.
 */
@Injectable()
export class CategoriesService {
  private readonly logger = new Logger(CategoriesService.name);

  /** Far above the eight the SOW names; a signal, not a page size. */
  private static readonly MAX_CATEGORIES = 200;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(query: ListCategoriesQueryDto): Promise<CategoryWithCount[]> {
    const where: Prisma.ProductCategoryWhereInput = {
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
      // The catalogue navigation hides categories with nothing in them; the
      // admin table shows them, because an empty category is exactly what an
      // administrator has just created and needs to fill.
      ...(query.includeEmpty ? {} : { products: { some: { deletedAt: null, status: 'ACTIVE' } } }),
    };

    return this.prisma.productCategory.findMany({
      where,
      include: { _count: { select: { products: { where: { deletedAt: null } } } } },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      take: CategoriesService.MAX_CATEGORIES,
    });
  }

  async findById(categoryId: string): Promise<CategoryWithCount> {
    const category = await this.prisma.productCategory.findFirst({
      where: { id: categoryId, deletedAt: null },
      include: { _count: { select: { products: { where: { deletedAt: null } } } } },
    });
    if (!category) throw new NotFoundError('Category');
    return category;
  }

  /** Used by the bulk importer, which names categories by code, not by id. */
  async findIdByCode(code: string): Promise<string | null> {
    const category = await this.prisma.productCategory.findFirst({
      where: { code: code.trim().toUpperCase(), deletedAt: null },
      select: { id: true },
    });
    return category?.id ?? null;
  }

  async create(dto: CreateCategoryDto, accountId: string): Promise<CategoryWithCount> {
    const clash = await this.prisma.productCategory.findUnique({
      where: { code: dto.code },
      select: { id: true, deletedAt: true },
    });

    if (clash) {
      // A soft-deleted category still holds the code, because the unique index
      // covers every row. Saying so beats a constraint error the caller cannot
      // interpret.
      throw new ConflictError(
        clash.deletedAt
          ? `Category code "${dto.code}" belongs to a deactivated category and cannot be reused`
          : `Category code "${dto.code}" is already in use`,
        { details: { code: dto.code } },
      );
    }

    const category = await this.prisma.productCategory.create({
      data: {
        id: createId('cat'),
        code: dto.code,
        name: dto.name,
        description: dto.description ?? null,
        sortOrder: dto.sortOrder,
      },
      include: { _count: { select: { products: true } } },
    });

    await this.audit.record({
      action: AuditAction.CATEGORY_CREATED,
      entityType: 'PRODUCT',
      entityId: category.id,
      entityName: `${category.code} — ${category.name}`,
      accountId,
      details: { code: category.code, name: category.name },
    });

    this.logger.log(`Created category ${category.id} (${category.code}).`);
    return category;
  }

  async update(
    categoryId: string,
    dto: UpdateCategoryDto,
    accountId: string,
  ): Promise<CategoryWithCount> {
    await this.findById(categoryId);

    const category = await this.prisma.productCategory.update({
      where: { id: categoryId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
      },
      include: { _count: { select: { products: { where: { deletedAt: null } } } } },
    });

    await this.audit.record({
      action: AuditAction.CATEGORY_UPDATED,
      entityType: 'PRODUCT',
      entityId: categoryId,
      entityName: `${category.code} — ${category.name}`,
      accountId,
      details: { changes: dto },
    });

    return category;
  }

  /**
   * Soft delete, and refused while products still point at it.
   *
   * `categoryId` is a required column on Product, so deactivating a category
   * with products in it would leave rows referencing something the catalogue no
   * longer lists — and every catalogue query joins through it. Moving the
   * products first is the administrator's decision, not one to make for them.
   */
  async deactivate(categoryId: string, accountId: string): Promise<void> {
    const category = await this.findById(categoryId);

    if (category._count.products > 0) {
      throw new BusinessRuleError(
        `This category still has ${category._count.products} product(s). ` +
          'Move or delete them before deactivating it.',
        { details: { productCount: category._count.products } },
      );
    }

    await this.prisma.productCategory.update({
      where: { id: categoryId },
      data: { status: 'INACTIVE', deletedAt: new Date() },
    });

    await this.audit.record({
      action: AuditAction.CATEGORY_DEACTIVATED,
      entityType: 'PRODUCT',
      entityId: categoryId,
      entityName: `${category.code} — ${category.name}`,
      accountId,
    });

    this.logger.log(`Deactivated category ${categoryId} (${category.code}).`);
  }
}
