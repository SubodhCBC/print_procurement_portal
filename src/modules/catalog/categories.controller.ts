import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission, RequirePermissions, type AuthenticatedActor } from '@/common';
import { zodBody } from '@/common/pipes/zod-validation.pipe';
import { ApiZodBody } from '@/common/utils/swagger-zod';
import { CurrentUser } from '@/modules/auth';
import { CategoriesService } from './categories.service';
import {
  CreateCategorySchema,
  ListCategoriesQuerySchema,
  UpdateCategorySchema,
  type CreateCategoryDto,
  type ListCategoriesQueryDto,
  type UpdateCategoryDto,
} from './dto/category.dto';
import { toCategoryView, type CategoryView } from './dto/product-response';

@ApiTags('catalog')
@ApiBearerAuth('access-token')
@Controller('catalog/categories')
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  /**
   * Readable by anyone who can see the catalogue — the category filter is the
   * first thing the shop renders. Writing is CATALOG_MANAGE, which only ADMIN
   * holds: the taxonomy is the platform operator's, not a customer's.
   */
  @Get()
  @RequirePermissions(Permission.CATALOG_VIEW)
  @ApiOperation({
    summary: 'List catalogue categories',
    description: 'Unpaginated — there are eight of these, and the navigation renders them all.',
  })
  async list(
    @Query(zodBody(ListCategoriesQuerySchema)) query: ListCategoriesQueryDto,
  ): Promise<readonly CategoryView[]> {
    const categories = await this.categories.list(query);
    return categories.map(toCategoryView);
  }

  @Get(':categoryId')
  @RequirePermissions(Permission.CATALOG_VIEW)
  @ApiOperation({ summary: 'One category' })
  async findOne(@Param('categoryId') categoryId: string): Promise<CategoryView> {
    return toCategoryView(await this.categories.findById(categoryId));
  }

  @Post()
  @RequirePermissions(Permission.CATALOG_MANAGE)
  @ApiOperation({ summary: 'Create a category' })
  @ApiZodBody(CreateCategorySchema, {
    example: {
      code: 'BUSINESS_CARDS',
      name: 'Business Cards',
      description: 'Standard and premium card stock',
      sortOrder: 30,
    },
  })
  async create(
    @CurrentUser() actor: AuthenticatedActor,
    @Body(zodBody(CreateCategorySchema)) body: CreateCategoryDto,
  ): Promise<CategoryView> {
    return toCategoryView(await this.categories.create(body, actor.accountId));
  }

  @Patch(':categoryId')
  @RequirePermissions(Permission.CATALOG_MANAGE)
  @ApiOperation({
    summary: 'Update a category',
    description: '`code` cannot be changed: it appears in import files and saved URLs.',
  })
  @ApiZodBody(UpdateCategorySchema, { example: { name: 'Business Cards', sortOrder: 10 } })
  async update(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('categoryId') categoryId: string,
    @Body(zodBody(UpdateCategorySchema)) body: UpdateCategoryDto,
  ): Promise<CategoryView> {
    return toCategoryView(await this.categories.update(categoryId, body, actor.accountId));
  }

  @Delete(':categoryId')
  @HttpCode(204)
  @RequirePermissions(Permission.CATALOG_MANAGE)
  @ApiOperation({
    summary: 'Deactivate a category',
    description:
      'Refused while products still point at it — every catalogue query joins through the ' +
      'category, so orphaning them would break the listing rather than tidy it.',
  })
  async deactivate(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('categoryId') categoryId: string,
  ): Promise<void> {
    await this.categories.deactivate(categoryId, actor.accountId);
  }
}
