import { Module } from '@nestjs/common';
import { PricingModule } from '@/modules/pricing';
import { TemplatesModule } from '@/modules/templates';
import { CartController } from './cart.controller';
import { CartService } from './cart.service';

/**
 * Baskets and checkout validation (SOW BE-05).
 *
 * Imports PricingModule, which imports CatalogModule. The chain runs one way:
 * catalog knows nothing about contracts, pricing knows nothing about baskets.
 * That is what keeps product visibility decided in exactly one function —
 * `ProductsService.visibilityFilter()` — with the cart reaching it through the
 * quote endpoint rather than querying products itself.
 *
 * Exported for BE-06, which takes `checkoutSession()`'s output and writes the
 * order from it. The order write deliberately lives there and not here: closing
 * the basket, reserving stock and creating the order are one transaction, and
 * splitting them across two modules would leave a half-committed state whenever
 * the second half failed.
 */
@Module({
  // TemplatesModule so a personalised line can be checked against the artwork
  // it claims to come from — published, visible to this buyer, and the version
  // currently live. Templates knows nothing about carts, so the dependency runs
  // one way.
  imports: [PricingModule, TemplatesModule],
  controllers: [CartController],
  providers: [CartService],
  exports: [CartService],
})
export class CartModule {}
