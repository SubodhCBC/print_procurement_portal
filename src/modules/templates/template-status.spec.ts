import { describe, expect, it } from 'vitest';
import { BusinessRuleError } from '@/common';
import {
  acceptCustomisation,
  allowedTransitions,
  assertLayersWellFormed,
  assertPublishable,
  assertTransition,
  canTransition,
  CUSTOMER_VISIBLE_STATUSES,
  editableFieldKey,
  editableLayers,
  ignoredEditableLayers,
  MAX_FIELD_LENGTH,
  normaliseTemplateCode,
  TemplateStatus,
  type TemplateLayerLike,
} from './template-status';

/**
 * The template rules, which two very different callers depend on: the builder,
 * where getting them wrong loses a designer's work, and the customiser, where
 * getting them wrong lets a buyer rewrite artwork the designer locked.
 *
 * `acceptCustomisation` is the security boundary of this module. Its tests are
 * the longest section here on purpose.
 */

const layer = (over: Partial<TemplateLayerLike> = {}): TemplateLayerLike => ({
  id: 'layer-1',
  type: 'text',
  name: 'Business name',
  label: 'Your branch name',
  isEditableBySiteUser: true,
  // Editable layers carry a field key: `assertPublishable` requires one, so a
  // fixture without it would be a template the builder could not publish.
  fieldKey: 'businessName',
  content: 'Apex Midtown',
  ...over,
});

describe('the lifecycle', () => {
  it('publishes a draft and takes it back off again', () => {
    expect(canTransition(TemplateStatus.DRAFT, TemplateStatus.PUBLISHED)).toBe(true);
    expect(canTransition(TemplateStatus.PUBLISHED, TemplateStatus.DRAFT)).toBe(true);
  });

  it('lets an archived template come back to the workbench', () => {
    // A seasonal template returns next year. It lands in DRAFT, never straight
    // on the storefront, so somebody looks at it before customers do.
    expect(canTransition(TemplateStatus.ARCHIVED, TemplateStatus.DRAFT)).toBe(true);
    expect(canTransition(TemplateStatus.ARCHIVED, TemplateStatus.PUBLISHED)).toBe(false);
  });

  it('refuses a transition to itself', () => {
    // Republishing is `publish()`, which cuts a version. A status change that
    // silently did nothing would look like it had worked.
    for (const status of Object.values(TemplateStatus)) {
      expect(canTransition(status, status)).toBe(false);
    }
  });

  it('names what is allowed when it refuses', () => {
    // An error that only says "no" makes the caller guess.
    expect(() => assertTransition(TemplateStatus.ARCHIVED, TemplateStatus.PUBLISHED)).toThrow(
      /may become: DRAFT/,
    );
  });

  it('shows customers published templates and nothing else', () => {
    expect(CUSTOMER_VISIBLE_STATUSES).toEqual([TemplateStatus.PUBLISHED]);
  });

  it('has no dead end — every status can move somewhere', () => {
    for (const status of Object.values(TemplateStatus)) {
      expect(allowedTransitions(status).length).toBeGreaterThan(0);
    }
  });
});

describe('normaliseTemplateCode', () => {
  it('upper-cases and trims, so two spellings cannot both exist', () => {
    expect(normaliseTemplateCode('  tpl-001 ')).toBe('TPL-001');
  });
});

describe('editable layers', () => {
  it('keys on fieldKey when the designer set one', () => {
    // What makes "businessName" mean the same thing on a poster and a business
    // card, so a buyer's details can be pre-filled rather than retyped.
    expect(editableFieldKey(layer({ fieldKey: 'businessName' }))).toBe('businessName');
  });

  it('falls back to the layer id when they did not', () => {
    expect(editableFieldKey(layer({ id: 'layer-7', fieldKey: undefined }))).toBe('layer-7');
  });

  it('leaves locked layers out', () => {
    const layers = [layer({ id: 'a' }), layer({ id: 'b', isEditableBySiteUser: false })];
    expect(editableLayers(layers).map((l) => l.id)).toEqual(['a']);
  });
});

describe('assertLayersWellFormed', () => {
  it('accepts a design with distinct ids and keys', () => {
    expect(() =>
      assertLayersWellFormed([
        layer({ id: 'a', fieldKey: 'businessName' }),
        layer({ id: 'b', fieldKey: 'phone' }),
      ]),
    ).not.toThrow();
  });

  it('refuses two layers sharing an id', () => {
    // Without unique ids the customiser cannot say which layer a value is for.
    expect(() => assertLayersWellFormed([layer({ id: 'a' }), layer({ id: 'a' })])).toThrow(
      BusinessRuleError,
    );
  });

  it('refuses two editable layers sharing a field key', () => {
    // One input would drive two boxes, and the buyer would never know which.
    expect(() =>
      assertLayersWellFormed([
        layer({ id: 'a', fieldKey: 'phone' }),
        layer({ id: 'b', fieldKey: 'phone' }),
      ]),
    ).toThrow(/one input for both/);
  });

  it('allows a locked layer to share a key with an editable one', () => {
    // Only editable keys are addressable, so this collides with nothing. The
    // locked layer is unreachable either way — see the acceptCustomisation
    // tests, which prove that is enforced and not merely assumed.
    expect(() =>
      assertLayersWellFormed([
        layer({ id: 'a', fieldKey: 'phone' }),
        layer({ id: 'b', fieldKey: 'phone', isEditableBySiteUser: false }),
      ]),
    ).not.toThrow();
  });
});

describe('assertPublishable', () => {
  it('accepts a named template with artwork on it', () => {
    expect(() => assertPublishable({ name: 'Poster', layers: [layer()] })).not.toThrow();
  });

  it('refuses one with no layers', () => {
    // It would print as a blank sheet, and the buyer would have bought nothing.
    expect(() => assertPublishable({ name: 'Poster', layers: [] })).toThrow(/blank sheet/);
  });

  it('refuses one with a blank name', () => {
    expect(() => assertPublishable({ name: '   ', layers: [layer()] })).toThrow(/needs a name/);
  });

  it('refuses one whose layers are malformed', () => {
    // Publishing is the last gate before customers see it, so the structural
    // checks run here too rather than only on save.
    expect(() =>
      assertPublishable({ name: 'Poster', layers: [layer({ id: 'a' }), layer({ id: 'a' })] }),
    ).toThrow(BusinessRuleError);
  });
});

describe('acceptCustomisation — the security boundary', () => {
  const layers = [
    layer({ id: 'name', fieldKey: 'businessName', isRequired: true }),
    layer({ id: 'phone', fieldKey: 'phone', content: '' }),
    layer({
      id: 'disclaimer',
      fieldKey: 'disclaimer',
      isEditableBySiteUser: false,
      label: 'Legal disclaimer',
      content: 'Prescription medicines are subject to conditions.',
    }),
  ];

  it('accepts the values the designer opened up', () => {
    expect(
      acceptCustomisation(layers, { businessName: 'Apex Midtown', phone: '+61 3 9000 0000' }),
    ).toEqual({ businessName: 'Apex Midtown', phone: '+61 3 9000 0000' });
  });

  it('refuses a value aimed at a locked layer', () => {
    // The whole product rule: an admin designs, a buyer fills in the boxes the
    // admin left open. The customiser is a web page and can be made to send
    // anything, so this is where the rule is actually enforced.
    expect(() =>
      acceptCustomisation(layers, {
        businessName: 'Apex',
        disclaimer: 'No conditions apply.',
      }),
    ).toThrow(/not editable on this template/);
  });

  it('names the locked field rather than saying "invalid"', () => {
    // A designer reading a support ticket needs to know which box was refused.
    expect(() => acceptCustomisation(layers, { businessName: 'Apex', disclaimer: 'x' })).toThrow(
      /Legal disclaimer/,
    );
  });

  it('refuses a key the template does not have at all', () => {
    expect(() => acceptCustomisation(layers, { businessName: 'Apex', nope: 'x' })).toThrow(
      /no editable field called "nope"/,
    );
  });

  it('rebuilds the record rather than passing the caller object through', () => {
    // The reason a stray key cannot survive by accident: the result is
    // constructed from the template's own layers, not filtered from the input.
    const submitted = { businessName: 'Apex' };
    const accepted = acceptCustomisation(layers, submitted);

    expect(accepted).not.toBe(submitted);
    expect(Object.keys(accepted)).toEqual(['businessName']);
  });

  it('refuses a missing required field', () => {
    expect(() => acceptCustomisation(layers, { phone: '123' })).toThrow(/is required/);
  });

  it('leaves an optional blank out rather than storing an empty string', () => {
    // So "the buyer cleared this" and "the buyer never saw this" stay
    // distinguishable to whatever renders the artwork.
    const accepted = acceptCustomisation(layers, { businessName: 'Apex', phone: '' });

    expect(accepted).toEqual({ businessName: 'Apex' });
    expect('phone' in accepted).toBe(false);
  });

  it('refuses a required field submitted blank', () => {
    expect(() => acceptCustomisation(layers, { businessName: '' })).toThrow(/is required/);
  });

  it('refuses a value that is not text', () => {
    // JSON carries numbers, objects and arrays; a layer's content is a string,
    // and coercing silently is how `[object Object]` reaches a printing press.
    expect(() => acceptCustomisation(layers, { businessName: { toString: 1 } })).toThrow(
      /must be text/,
    );
  });

  it('refuses a value longer than the cap', () => {
    expect(() =>
      acceptCustomisation(layers, { businessName: 'x'.repeat(MAX_FIELD_LENGTH + 1) }),
    ).toThrow(/longer than/);
  });

  it('accepts a value exactly at the cap', () => {
    const value = 'x'.repeat(MAX_FIELD_LENGTH);
    expect(acceptCustomisation(layers, { businessName: value })).toEqual({ businessName: value });
  });

  it('accepts nothing at all when no field is required', () => {
    const optional = [layer({ id: 'phone', fieldKey: 'phone' })];
    expect(acceptCustomisation(optional, {})).toEqual({});
  });

  it('does not read an inherited value for a field the template does have', () => {
    // The loop asks the *template* for a key and looks it up on the caller's
    // object, which is the one direction an inherited property could be read as
    // though the buyer had sent it. The template here really does have
    // `businessName`, so this fails unless the lookup is own-properties-only.
    const withInherited = Object.create({ businessName: 'inherited' }) as Record<string, unknown>;
    withInherited.phone = '123';

    const optional = [
      layer({ id: 'name', fieldKey: 'businessName' }),
      layer({ id: 'phone', fieldKey: 'phone' }),
    ];

    expect(acceptCustomisation(optional, withInherited)).toEqual({ phone: '123' });
  });

  it('still refuses a required field that only exists on the prototype', () => {
    // The same rule seen from the other side: an inherited value must not
    // satisfy a requirement the buyer never actually filled in.
    const withInherited = Object.create({ businessName: 'inherited' }) as Record<string, unknown>;

    expect(() =>
      acceptCustomisation(
        [layer({ id: 'name', fieldKey: 'businessName', isRequired: true })],
        withInherited,
      ),
    ).toThrow(/is required/);
  });
});

describe('what a buyer may actually be asked to fill in', () => {
  it('offers a text layer the designer opened up', () => {
    expect(editableLayers([layer()]).map((l) => l.id)).toEqual(['layer-1']);
  });

  it('does not offer a shape, even when it is marked editable', () => {
    // Ticking "editable by site user" on a rectangle is easy to do by accident
    // in the builder, and the customiser used to answer it with a text box
    // labelled "Rect" that did nothing whatever the buyer typed.
    const shapes = ['rect', 'circle', 'path', 'line', 'divider', 'polygon'];

    for (const type of shapes) {
      expect(editableLayers([layer({ type, fieldKey: 'x' })])).toEqual([]);
    }
  });

  it('does not offer an image or a logo yet', () => {
    // Personalising these means uploading a file, and that flow does not exist.
    // Offering a text box for a logo would be a worse answer than offering none.
    for (const type of ['image', 'logo']) {
      expect(editableLayers([layer({ type, fieldKey: 'x' })])).toEqual([]);
    }
  });

  it('offers a code layer, which does carry a payload the buyer sets', () => {
    for (const type of ['qrcode', 'barcode']) {
      expect(editableLayers([layer({ type, fieldKey: 'x' })])).toHaveLength(1);
    }
  });

  it('reports the ones it silently ignored, so the builder can say so', () => {
    const layers = [layer({ id: 'a' }), layer({ id: 'b', type: 'rect', fieldKey: 'box' })];

    expect(ignoredEditableLayers(layers).map((l) => l.id)).toEqual(['b']);
  });

  it('counts a locked shape as neither', () => {
    const layers = [layer({ id: 'a', type: 'rect', isEditableBySiteUser: false })];

    expect(editableLayers(layers)).toEqual([]);
    expect(ignoredEditableLayers(layers)).toEqual([]);
  });

  it('refuses a value aimed at a shape that was marked editable', () => {
    // The rule holds at the boundary too: a shape is not offered, so a value
    // for it is not accepted either.
    expect(() =>
      acceptCustomisation([layer({ type: 'rect', fieldKey: 'box' })], { box: '#ff0000' }),
    ).toThrow(/no editable field called "box"/);
  });
});

describe('publishing refuses an unnamed field', () => {
  it('accepts an editable layer that has a field key', () => {
    expect(() => assertPublishable({ name: 'Poster', layers: [layer()] })).not.toThrow();
  });

  it('accepts a form label in place of a field key', () => {
    // A one-off field deliberately has no shared key — the builder offers
    // "free text" for exactly that — and the buyer still reads the label. The
    // rule is that the field has a name, not that it has a merge key.
    expect(() =>
      assertPublishable({
        name: 'Poster',
        layers: [layer({ fieldKey: undefined, label: 'Campaign strapline' })],
      }),
    ).not.toThrow();
  });

  it('refuses one with neither', () => {
    expect(() =>
      assertPublishable({
        name: 'Poster',
        layers: [layer({ fieldKey: undefined, label: '' })],
      }),
    ).toThrow(/no field name/);
  });

  it('refuses one whose field key and label are only whitespace', () => {
    expect(() =>
      assertPublishable({
        name: 'Poster',
        layers: [layer({ fieldKey: '   ', label: '  ' })],
      }),
    ).toThrow(/no field name/);
  });

  it('refuses a label that is only the layer type', () => {
    // The builder's default for an unnamed layer, and the exact string this
    // rule exists to keep off a storefront.
    expect(() =>
      assertPublishable({
        name: 'Poster',
        layers: [layer({ type: 'text', fieldKey: undefined, label: 'Text' })],
      }),
    ).toThrow(/no field name/);
    expect(() =>
      assertPublishable({
        name: 'Poster',
        layers: [layer({ type: 'barcode', fieldKey: undefined, label: ' Barcode ' })],
      }),
    ).toThrow(/no field name/);
  });

  it('says how many are unnamed', () => {
    expect(() =>
      assertPublishable({
        name: 'Poster',
        layers: [
          layer({ id: 'a', fieldKey: undefined, label: '' }),
          layer({ id: 'b', fieldKey: undefined, label: '' }),
        ],
      }),
    ).toThrow(/2 editable layers have/);
  });

  it('accepts a code space named by its own merge field', () => {
    // The case this rule was blocking: an administrator marks out a barcode
    // area for the buyer to fill in.
    expect(() =>
      assertPublishable({
        name: 'Card',
        layers: [
          layer({ id: 'qr', type: 'qrcode', fieldKey: 'qrCode', label: 'Branch QR link' }),
          layer({ id: 'bc', type: 'barcode', fieldKey: 'barcode', label: 'Asset barcode' }),
        ],
      }),
    ).not.toThrow();
  });

  it('does not require a key on a locked layer', () => {
    // Only the boxes a buyer is asked to fill in need naming.
    expect(() =>
      assertPublishable({
        name: 'Poster',
        layers: [layer(), layer({ id: 'b', isEditableBySiteUser: false, fieldKey: undefined })],
      }),
    ).not.toThrow();
  });

  it('does not require a key on a shape that was marked editable', () => {
    // It is never offered, so there is nothing to name.
    expect(() =>
      assertPublishable({
        name: 'Poster',
        layers: [layer(), layer({ id: 'b', type: 'rect', fieldKey: undefined })],
      }),
    ).not.toThrow();
  });
});
