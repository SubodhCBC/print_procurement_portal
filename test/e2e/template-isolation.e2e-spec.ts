import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createId } from '@/common';
import { loadConfig } from '@/config';
import { PrismaService } from '@/database';

/**
 * The template guarantees that live in the database (SOW FE-13).
 *
 * The service-level rules — who may publish, what a buyer may personalise — are
 * covered by `template-status.spec.ts` and by the module's own smoke. What is
 * proved here is the half a service cannot enforce alone:
 *
 * 1. **A published template always has something to render.** A bad transition
 *    would otherwise leave a template the storefront lists and then cannot
 *    draw, and the failure would surface to a buyer rather than to the operator
 *    who caused it.
 *
 * 2. **Versions are immutable in practice.** Nothing in the API updates one,
 *    and an order personalised from a version must still resolve it after the
 *    draft has moved on — so a published version survives the draft changing,
 *    and survives the template being archived.
 *
 * 3. **Restricted visibility is a join, not a copied column.** A template
 *    restricted to one account must be invisible to another, and the predicate
 *    that decides it is one EXISTS rather than a flag that can drift.
 *
 * Needs Postgres running (`npm run infra:up`) with migrations applied
 * (`npm run db:deploy`).
 */
describe('template integrity and visibility (e2e)', () => {
  let prisma: PrismaService;

  const suffix = Date.now().toString(36);
  const accountA = createId('acc');
  const accountB = createId('acc');
  const categoryId = createId('cat');
  const templateId = createId('tpl');
  const restrictedId = createId('tpl');

  const canvas = { backgroundColor: '#FFFFFF' };
  const layers = [
    {
      id: 'layer-1',
      type: 'text',
      name: 'Business name',
      label: 'Your branch name',
      isEditableBySiteUser: true,
      fieldKey: 'businessName',
      content: 'Apex',
    },
  ];

  const baseTemplate = (id: string, code: string) => ({
    id,
    code,
    name: `Template ${code}`,
    categoryId,
    widthValue: '16.500',
    heightValue: '23.400',
    dimensionUnit: 'IN' as const,
    bleedMargin: '0.125',
    safeMargin: '0.250',
    canvasConfig: canvas,
    layers,
  });

  beforeAll(async () => {
    loadConfig();
    prisma = new PrismaService();
    await prisma.$connect();

    for (const [id, code] of [
      [accountA, `TPA-${suffix}`],
      [accountB, `TPB-${suffix}`],
    ] as const) {
      await prisma.account.create({
        data: { id, slug: code.toLowerCase(), accountCode: code, name: `Tpl ${code}` },
      });
    }

    await prisma.productCategory.create({
      data: { id: categoryId, code: `TPL-${suffix}`, name: 'Template fixtures' },
    });

    await prisma.template.create({ data: baseTemplate(templateId, `TPL-A-${suffix}`) });
  });

  afterAll(async () => {
    await prisma?.template.deleteMany({ where: { categoryId } });
    await prisma?.productCategory.deleteMany({ where: { id: categoryId } });
    await prisma?.account.deleteMany({ where: { id: { in: [accountA, accountB] } } });
    await prisma?.$disconnect();
  });

  describe('a published template always has something to render', () => {
    it('refuses PUBLISHED with no version behind it', async () => {
      await expect(
        prisma.template.update({ where: { id: templateId }, data: { status: 'PUBLISHED' } }),
      ).rejects.toThrow(/templates_published_has_version/);
    });

    it('accepts PUBLISHED once a version exists', async () => {
      const versionId = createId('tpv');
      await prisma.templateVersion.create({
        data: {
          id: versionId,
          templateId,
          version: 1,
          snapshot: { code: 'X', name: 'X', layers, canvasConfig: canvas },
          label: 'Published',
        },
      });

      await expect(
        prisma.template.update({
          where: { id: templateId },
          data: { status: 'PUBLISHED', publishedVersionId: versionId, publishedAt: new Date() },
        }),
      ).resolves.toMatchObject({ status: 'PUBLISHED' });
    });

    it('keeps the pointer when the template is archived', async () => {
      // The check is deliberately one-directional. An order personalised from a
      // version must still resolve it after the template leaves the storefront;
      // clearing the pointer would strand exactly the customers who committed.
      const archived = await prisma.template.update({
        where: { id: templateId },
        data: { status: 'ARCHIVED' },
      });

      expect(archived.publishedVersionId).not.toBeNull();
    });
  });

  describe('a version does not move when the draft does', () => {
    it('keeps its snapshot after the draft is rewritten', async () => {
      const before = await prisma.templateVersion.findFirstOrThrow({ where: { templateId } });

      await prisma.template.update({
        where: { id: templateId },
        data: {
          name: 'Rewritten after publication',
          layers: [],
          version: { increment: 1 },
        },
      });

      const after = await prisma.templateVersion.findUniqueOrThrow({ where: { id: before.id } });
      expect(after.snapshot).toEqual(before.snapshot);
    });

    it('refuses two versions numbered the same', async () => {
      // What makes "restore version 3" unambiguous.
      await expect(
        prisma.templateVersion.create({
          data: {
            id: createId('tpv'),
            templateId,
            version: 1,
            snapshot: {},
          },
        }),
      ).rejects.toThrow();
    });

    it('refuses a version numbered zero', async () => {
      await expect(
        prisma.templateVersion.create({
          data: { id: createId('tpv'), templateId, version: 0, snapshot: {} },
        }),
      ).rejects.toThrow(/template_versions_version_positive/);
    });
  });

  describe('the constraints that stop a malformed template existing', () => {
    it('refuses a canvas with no area', async () => {
      await expect(
        prisma.template.create({
          data: { ...baseTemplate(createId('tpl'), `BAD-W-${suffix}`), widthValue: '0' },
        }),
      ).rejects.toThrow(/templates_dimensions_positive/);
    });

    it('refuses a negative margin', async () => {
      // Zero is fine — a full-bleed sticker has no safe area to speak of.
      await expect(
        prisma.template.create({
          data: { ...baseTemplate(createId('tpl'), `BAD-M-${suffix}`), safeMargin: '-1' },
        }),
      ).rejects.toThrow(/templates_margins_not_negative/);
    });

    it('refuses a zero-byte asset', async () => {
      // A zero-byte upload is a failed upload, and recording it as an asset is
      // how a listing renders a broken tile with nothing to explain it.
      await expect(
        prisma.templateAsset.create({
          data: {
            id: createId('tpa'),
            templateId,
            storageKey: `artwork/template/EMPTY-${suffix}/x.png`,
            filename: 'x.png',
            contentType: 'image/png',
            sizeBytes: 0,
          },
        }),
      ).rejects.toThrow(/template_assets_size_positive/);
    });

    it('refuses two templates sharing a code', async () => {
      await expect(
        prisma.template.create({ data: baseTemplate(createId('tpl'), `TPL-A-${suffix}`) }),
      ).rejects.toThrow();
    });
  });

  describe('restricted visibility', () => {
    beforeAll(async () => {
      const versionId = createId('tpv');
      await prisma.template.create({
        data: {
          ...baseTemplate(restrictedId, `TPL-R-${suffix}`),
          visibility: 'RESTRICTED',
        },
      });
      await prisma.templateVersion.create({
        data: { id: versionId, templateId: restrictedId, version: 1, snapshot: {} },
      });
      await prisma.template.update({
        where: { id: restrictedId },
        data: { status: 'PUBLISHED', publishedVersionId: versionId, publishedAt: new Date() },
      });
      await prisma.templateAccountVisibility.create({
        data: { id: createId('tav'), templateId: restrictedId, accountId: accountA },
      });
    });

    /** The predicate TemplatesService.visibilityFilter() builds. */
    const visibleTo = (accountId: string) =>
      prisma.template.findMany({
        where: {
          AND: [
            { deletedAt: null, status: 'PUBLISHED' },
            {
              OR: [
                { visibility: 'ALL_ACCOUNTS' },
                { visibility: 'RESTRICTED', visibleTo: { some: { accountId } } },
              ],
            },
            { categoryId },
          ],
        },
        select: { id: true },
      });

    it('shows a restricted template to the account it was granted to', async () => {
      const ids = (await visibleTo(accountA)).map((row) => row.id);
      expect(ids).toContain(restrictedId);
    });

    it('hides it from every other account', async () => {
      // The one thing this table can leak: not another customer's data — there
      // is none here — but a contract-specific design to somebody with no
      // contract for it.
      const ids = (await visibleTo(accountB)).map((row) => row.id);
      expect(ids).not.toContain(restrictedId);
    });

    it('stops showing it the moment the grant is withdrawn', async () => {
      await prisma.templateAccountVisibility.deleteMany({
        where: { templateId: restrictedId, accountId: accountA },
      });

      const ids = (await visibleTo(accountA)).map((row) => row.id);
      expect(ids).not.toContain(restrictedId);
    });

    it('takes its grants with it when the template is deleted', async () => {
      // ON DELETE CASCADE: a grant that outlived its template would be a row
      // nothing can ever clean up and nothing can ever use.
      const orphanId = createId('tpl');
      await prisma.template.create({ data: baseTemplate(orphanId, `TPL-O-${suffix}`) });
      await prisma.templateAccountVisibility.create({
        data: { id: createId('tav'), templateId: orphanId, accountId: accountB },
      });

      await prisma.template.delete({ where: { id: orphanId } });

      expect(
        await prisma.templateAccountVisibility.count({ where: { templateId: orphanId } }),
      ).toBe(0);
    });
  });

  describe('the index the gallery query needs', () => {
    it('covers the storefront listing', async () => {
      const rows = await prisma.$queryRaw<{ indexdef: string }[]>`
        SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'templates'`;

      const covered = rows.some((row) => {
        const bare = row.indexdef.replace(/"/g, '');
        return ['status', 'visibility', 'deletedAt'].every((column) =>
          new RegExp(`\\b${column}\\b`).test(bare),
        );
      });

      expect(covered).toBe(true);
    });
  });
});
