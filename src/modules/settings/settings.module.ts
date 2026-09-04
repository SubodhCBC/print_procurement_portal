import { Module } from '@nestjs/common';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

/**
 * An account's operational preferences: locale, ordering rules, alert routing
 * and session policy.
 *
 * SettingsService is exported because the rules it holds — MOQ enforcement,
 * backorders, the delivery-note requirement — belong to checkout as much as to
 * this screen, and cart validation will read them from here rather than
 * growing its own copy.
 */
@Module({
  controllers: [SettingsController],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
