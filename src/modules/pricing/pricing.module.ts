import { Module } from '@nestjs/common';
import { CatalogModule } from '@/modules/catalog';
import { PricingController } from './pricing.controller';
import { PricingService } from './pricing.service';
import { RateCardsController } from './rate-cards.controller';
import { RateCardsService } from './rate-cards.service';

/**
 * Rate cards and contract pricing (SOW BE-04).
 *
 * Imports CatalogModule and is never imported by it. The dependency runs one
 * way on purpose: pricing needs `ProductsService.findPriceable()` so that
 * product visibility stays decided in exactly one function, and the catalog
 * must not learn about contracts — otherwise the two would import each other
 * and the visibility rule would have somewhere else to drift to.
 *
 * That is also why a customer's contract price is served here, by
 * `POST /pricing/quote`, rather than being folded into the product read: one
 * call prices a whole grid, and the catalog stays global data with no tenant
 * knowledge in it.
 *
 * Exported for BE-05 (cart), which prices its lines through PricingService, and
 * BE-06, which snapshots the breakdown onto the order line so a later base
 * price change cannot rewrite what was ordered.
 */
@Module({
  imports: [CatalogModule],
  controllers: [RateCardsController, PricingController],
  providers: [RateCardsService, PricingService],
  exports: [RateCardsService, PricingService],
})
export class PricingModule {}
