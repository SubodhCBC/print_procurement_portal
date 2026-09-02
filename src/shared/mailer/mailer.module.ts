import { Global, Module } from '@nestjs/common';
import { EmailProcessor } from './email.processor';
import { MailDispatcher } from './mail.dispatcher';
import { MailService } from './mail.service';

/**
 * Transactional email: the producer side (MailDispatcher), the consumer side
 * (EmailProcessor) and the transport (MailService).
 *
 * Global because notifications are raised from every domain module and none of
 * them should have to import a mail module to say "an order was approved".
 *
 * The `email` queue itself is registered by QueueModule in the composition
 * root, so @InjectQueue resolves here without this module registering it a
 * second time — registering a queue twice creates two Queue instances with
 * different settings pointing at the same Redis keys.
 */
@Global()
@Module({
  providers: [MailService, MailDispatcher, EmailProcessor],
  exports: [MailService, MailDispatcher],
})
export class MailerModule {}
