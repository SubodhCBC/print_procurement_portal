export { CatalogModule } from './catalog.module';
export { CategoriesService } from './categories.service';
export type { CategoryWithCount } from './categories.service';
export { ProductsService } from './products.service';
export { StockService } from './stock.service';
export type { StockReconciliation, StockReconciliationLine } from './products.service';
export type { FullProduct, PriceableProduct } from './products.service';
export { ProductImportService, ImportJobPayloadSchema } from './product-import.service';
export type { ImportRowResult, ImportOutcome, ImportJobPayload } from './product-import.service';
export {
  AssetDerivativeService,
  DerivativeJobSchema,
  derivativeKey,
} from './asset-derivative.service';
export type { DerivativeJobPayload } from './asset-derivative.service';
export { ImportProcessor } from './import.processor';
export { DerivativeProcessor } from './derivative.processor';
export {
  assertTransition,
  canTransition,
  isOrderable,
  ProductStatus,
  requiresSuccessor,
  CUSTOMER_VISIBLE_STATUSES,
  ORDERABLE_STATUSES,
} from './product-status';
export {
  applyDiscount,
  isOrderableQuantity,
  priceLadder,
  priceLine,
  roundToOrderable,
  selectTier,
} from './product-pricing';
export type { PriceBreakdown, PriceInput, VolumeTier } from './product-pricing';
export {
  toCategoryView,
  toProductView,
  toOptionView,
  toImportJobView,
} from './dto/product-response';
export type {
  CategoryView,
  ProductView,
  ProductVariantView,
  ProductAssetView,
  ProductOptionView,
  VolumeTierView,
  ImportJobView,
  ImportJobSummaryRow,
} from './dto/product-response';
