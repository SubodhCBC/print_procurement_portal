import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission, RequirePermissions, type AuthenticatedActor } from '@/common';
import { zodBody } from '@/common/pipes/zod-validation.pipe';
import { ApiZodBody } from '@/common/utils/swagger-zod';
import { CurrentUser } from '@/modules/auth';
import { ReconcileStockSchema, type ReconcileStockDto } from './dto/product.dto';
import { ProductsService, type StockReconciliation } from './products.service';

/**
 * Warehouse operations (SOW BE-12).
 *
 * Its own controller rather than more routes under `catalog/products`: a
 * stocktake is an operation on the warehouse, not on one product, and nesting
 * it would have produced `/catalog/products/inventory/reconcile` — a path that
 * reads as a product called "inventory".
 *
 * Per-product stock *adjustments* stay on the product controller, because those
 * genuinely are about one product and are reached from its row in the admin UI.
 */
@ApiTags('catalog')
@ApiBearerAuth('access-token')
@Controller('catalog/inventory')
export class InventoryController {
  constructor(private readonly products: ProductsService) {}

  @Post('reconcile')
  // 200, not 201: a stocktake creates nothing. It reports, and sometimes
  // corrects.
  @HttpCode(200)
  @RequirePermissions(Permission.INVENTORY_MANAGE)
  @ApiOperation({
    summary: 'Apply a physical stocktake',
    description:
      'Absolute counts, not deltas — the opposite of `POST /catalog/products/:id/stock`. An ' +
      'adjustment says "three arrived"; a stocktake says "there are forty on the shelf", and ' +
      'asking whoever is holding the count sheet to work out the difference is how a stocktake ' +
      'introduces the error it exists to remove.\n\n' +
      'Every line comes back with its variance whether or not anything changed, because the ' +
      'discrepancy is the point of the exercise. `dryRun` reports without writing.\n\n' +
      'A count below what is already promised to placed orders is **refused**, not clamped. ' +
      'That is a real shortfall — cancel the orders or find the units — and writing it would ' +
      'break the invariant reservations rest on and leave someone to discover it at dispatch.',
  })
  @ApiZodBody(ReconcileStockSchema, {
    example: {
      reason: 'Quarterly stocktake — Q3 2026',
      dryRun: true,
      counts: [
        { sku: 'FLY-A5-DL', countedQuantity: 4820, note: 'Aisle 3, two pallets' },
        { sku: 'POS-A2', countedQuantity: 0 },
      ],
    },
  })
  async reconcile(
    @CurrentUser() actor: AuthenticatedActor,
    @Body(zodBody(ReconcileStockSchema)) body: ReconcileStockDto,
  ): Promise<StockReconciliation> {
    return this.products.reconcileStock(body, actor);
  }
}
