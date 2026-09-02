import { Module } from '@nestjs/common';
import { AssetDerivativeService } from './asset-derivative.service';
import { CategoriesController } from './categories.controller';
import { CategoriesService } from './categories.service';
import { DerivativeProcessor } from './derivative.processor';
import { ImportProcessor } from './import.processor';
import { ProductImportService } from './product-import.service';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';

/**
 * The product catalog (SOW BE-03).
 *
 * Global data: no tenant scope and no RLS on these tables, because the catalog
 * belongs to the platform operator rather than to any customer. What an account
 * may see is decided by ProductsService.visibilityFilter(), and the one
 * tenant-owned table — product_account_visibility — does carry a policy.
 *
 * Exported because BE-04 (rate cards) and BE-05 (cart and checkout) both need
 * to read products and price them; product-pricing.ts is the shared arithmetic
 * and is deliberately free of Prisma so both can call it.
 *
 * Two queue consumers live here rather than in shared/: both operate on
 * catalogue rows, and a processor belongs with the domain whose data it writes.
 * `import` is its own queue; derivatives ride the existing `render` queue,
 * which is the first thing to consume it.
 */
@Module({
  controllers: [CategoriesController, ProductsController],
  providers: [
    CategoriesService,
    ProductsService,
    ProductImportService,
    AssetDerivativeService,
    ImportProcessor,
    DerivativeProcessor,
  ],
  exports: [CategoriesService, ProductsService, AssetDerivativeService],
})
export class CatalogModule {}
