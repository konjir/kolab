import { Controller, Get, Header, Inject, ServiceUnavailableException } from '@nestjs/common';
import { Kolab } from '@konjir/engine';
import { KOLAB } from './tokens.js';

/** GET /healthz: ok when the database answers. The release installer waits on it. */
@Controller()
export class HealthController {
  constructor(@Inject(KOLAB) private readonly kolab: Kolab) {}

  @Get('healthz')
  @Header('content-type', 'text/plain')
  async health() {
    try { await this.kolab.db.query('select 1'); } catch { throw new ServiceUnavailableException('database unavailable'); }
    return 'ok';
  }
}
