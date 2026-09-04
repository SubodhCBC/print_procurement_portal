import { BusinessRuleError } from '@/common';

/**
 * The template lifecycle and the rules that guard personalisation (SOW FE-13).
 *
 * Pure and free of Prisma, for the same reason `product-status.ts` and
 * `order-status.ts` are: these rules are read by the admin builder, by the
 * storefront customiser and — when INT-01 lands — by the print production
 * payload builder. Every one of those callers must get the same answer, and a
 * rule that lives inside a service is a rule the next caller reimplements
 * slightly differently.
 */

/** Mirrors the Prisma `TemplateStatus` enum; template-status.spec.ts asserts it. */
export const TemplateStatus = {
  DRAFT: 'DRAFT',
  PUBLISHED: 'PUBLISHED',
  ARCHIVED: 'ARCHIVED',
} as const;

export type TemplateStatus = (typeof TemplateStatus)[keyof typeof TemplateStatus];

/**
 * The lifecycle, as a table rather than as `if`s scattered through the service.
 *
 * ```text
 *   DRAFT ◄──────► PUBLISHED
 *     │                │
 *     └──────► ARCHIVED ◄──────┘
 *              │
 *              └──► DRAFT   (restore, back to the workbench)
 * ```
 *
 * Three things are worth stating outright:
 *
 * - **PUBLISHED goes back to DRAFT.** Unlike a product, which never returns to
 *   draft, a template legitimately does: taking artwork off the storefront to
 *   rework it is ordinary. It is safe here precisely because orders reference a
 *   frozen `TemplateVersion` rather than this row — unpublishing removes it from
 *   the gallery and changes nothing already ordered.
 *
 * - **ARCHIVED is not terminal.** A seasonal template comes back next year. What
 *   archiving does is remove it from the gallery permanently rather than
 *   temporarily; restoring lands in DRAFT, never straight into the storefront,
 *   so somebody has to look at it before customers do.
 *
 * - **Nothing transitions to itself.** Re-publishing an already-published
 *   template is a *republish* — it cuts a new version — and goes through
 *   `publish()`, not through a status change that would silently do nothing.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<TemplateStatus, readonly TemplateStatus[]>> = {
  [TemplateStatus.DRAFT]: [TemplateStatus.PUBLISHED, TemplateStatus.ARCHIVED],
  [TemplateStatus.PUBLISHED]: [TemplateStatus.DRAFT, TemplateStatus.ARCHIVED],
  [TemplateStatus.ARCHIVED]: [TemplateStatus.DRAFT],
};

export function canTransition(from: TemplateStatus, to: TemplateStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function allowedTransitions(from: TemplateStatus): readonly TemplateStatus[] {
  return ALLOWED_TRANSITIONS[from];
}

export function assertTransition(from: TemplateStatus, to: TemplateStatus): void {
  if (canTransition(from, to)) return;

  const allowed = ALLOWED_TRANSITIONS[from];
  throw new BusinessRuleError(
    allowed.length === 0
      ? `A ${from} template cannot change status.`
      : `A ${from} template cannot become ${to}. It may become: ${allowed.join(', ')}.`,
    { details: { from, to, allowed } },
  );
}

/** The only status a customer ever sees. DRAFT and ARCHIVED are ours alone. */
export const CUSTOMER_VISIBLE_STATUSES: readonly TemplateStatus[] = [TemplateStatus.PUBLISHED];

/**
 * The operator-facing code, normalised.
 *
 * Upper-cased and trimmed on write, exactly as product SKUs are, so `tpl-001`
 * and `TPL-001` cannot both exist and then confuse the person searching for
 * one of them.
 */
export function normaliseTemplateCode(code: string): string {
  return code.trim().toUpperCase();
}

/**
 * The shape this module needs from a layer.
 *
 * Deliberately narrower than the front end's `TemplateLayer`: geometry, styling
 * and z-order are the editor's business, and a rule engine that knew about them
 * would have to change every time a designer gained a new control.
 */
export interface TemplateLayerLike {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly label: string;
  readonly helperText?: string;
  readonly isEditableBySiteUser: boolean;
  readonly fieldKey?: string;
  readonly isRequired?: boolean;
  readonly content: string;
}

/**
 * Layer types a buyer can actually type into.
 *
 * A `rect`, a `circle` or a `path` has no content — it is a coloured shape.
 * Marking one "editable by site user" in the builder is easy to do by accident,
 * and the customiser used to answer it with a text box labelled "Rect" that did
 * nothing whatever the buyer typed. Filtering here rather than in the
 * customiser means the same answer reaches the field list, the validator and
 * the editable-field count.
 *
 * `image` and `logo` are excluded for a different reason: they are personalised
 * by uploading a file, and that flow does not exist yet. When it does they
 * belong here, and nothing else changes.
 */
export const PERSONALISABLE_TYPES: readonly string[] = [
  'text',
  'badge',
  // Both carry a payload the buyer legitimately sets — a branch URL, a batch
  // code — even though neither is prose.
  'qrcode',
  'barcode',
];

export function isPersonalisableType(type: string): boolean {
  return PERSONALISABLE_TYPES.includes(type);
}

/**
 * Layers a buyer may fill in, keyed by what the customiser submits.
 *
 * The key is `fieldKey` when the designer set one — that is what makes
 * "businessName" mean the same thing across every template, so a buyer's
 * details can be pre-filled — and the layer id otherwise.
 */
export function editableFieldKey(layer: TemplateLayerLike): string {
  return layer.fieldKey ?? layer.id;
}

/**
 * Whether a buyer would be told what this field is for.
 *
 * Either a merge field or a form label will do. A label equal to the layer's
 * own type does not: that is the builder's default for an unnamed layer, and
 * it is the exact string — "Text", "Path", "Rect" — this check exists to keep
 * off a storefront.
 */
function isNamed(layer: TemplateLayerLike): boolean {
  const key = layer.fieldKey?.trim() ?? '';
  if (key.length > 0) return true;
  const label = layer.label?.trim() ?? '';
  if (label.length === 0) return false;
  return label.toLowerCase() !== layer.type.trim().toLowerCase();
}

/**
 * The layers a buyer is actually offered.
 *
 * Both conditions matter: the designer marked it editable *and* it is a type
 * that holds content. A shape that was marked editable is silently not offered
 * rather than refused at publish time — the designer's intent is unclear, and
 * blocking a whole template over a stray checkbox on a rectangle would be worse
 * than ignoring it.
 */
export function editableLayers(layers: readonly TemplateLayerLike[]): readonly TemplateLayerLike[] {
  return layers.filter((layer) => layer.isEditableBySiteUser && isPersonalisableType(layer.type));
}

/**
 * Layers the designer marked editable that a buyer will never see, because
 * their type holds no content.
 *
 * Surfaced so the builder can say so rather than leaving a designer wondering
 * why their field never appeared in the storefront.
 */
export function ignoredEditableLayers(
  layers: readonly TemplateLayerLike[],
): readonly TemplateLayerLike[] {
  return layers.filter((layer) => layer.isEditableBySiteUser && !isPersonalisableType(layer.type));
}

/**
 * Structural checks on a design, run before it is stored.
 *
 * Not a validation of the artwork — nothing here can tell whether a poster
 * looks right. These are the invariants that make the document *addressable*:
 * without unique ids the customiser cannot say which layer a value belongs to,
 * and without a unique field key two boxes would fight over one input.
 */
export function assertLayersWellFormed(layers: readonly TemplateLayerLike[]): void {
  const ids = new Set<string>();
  for (const layer of layers) {
    if (ids.has(layer.id)) {
      throw new BusinessRuleError(`Two layers share the id "${layer.id}".`, {
        details: { layerId: layer.id },
      });
    }
    ids.add(layer.id);
  }

  const keys = new Set<string>();
  for (const layer of editableLayers(layers)) {
    const key = editableFieldKey(layer);
    if (keys.has(key)) {
      throw new BusinessRuleError(
        `Two editable layers share the field key "${key}". A buyer would have one input for both.`,
        { details: { fieldKey: key } },
      );
    }
    keys.add(key);
  }
}

/**
 * Whether a template is fit to go on the storefront.
 *
 * The bar is deliberately low and structural: a template with no layers renders
 * as a blank sheet, and a buyer who orders one has bought nothing. Anything
 * beyond that — is the artwork any good, is the logo the right one — is a human
 * judgement and belongs to the person pressing publish, not to a check that
 * would only ever be wrong in one direction.
 */
export function assertPublishable(template: {
  readonly name: string;
  readonly layers: readonly TemplateLayerLike[];
}): void {
  if (template.name.trim().length === 0) {
    throw new BusinessRuleError('A template needs a name before it can be published.');
  }

  if (template.layers.length === 0) {
    throw new BusinessRuleError(
      'A template with no layers would print as a blank sheet. Add artwork before publishing.',
    );
  }

  assertLayersWellFormed(template.layers);

  // A field with no name is a box a buyer is asked to fill in without being
  // told what for. The builder defaults an unnamed layer's label to its fabric
  // type, so this is what stops "Text" and "Path" reaching a storefront as
  // questions. Caught at publish rather than at save: a half-labelled draft is
  // an ordinary state to be in halfway through an afternoon.
  //
  // A *label* satisfies it, not only a field key. The two are different things:
  // `fieldKey` makes the field mean the same across templates so a buyer's
  // details can be pre-filled, while the label is what they actually read. This
  // rule demanded the key, and the builder offers "free text" for a one-off
  // field that deliberately has none — a combination that saved happily and
  // then refused to publish, blaming the builder for a choice the builder
  // offered. Requiring a name, by either route, is what the comment above
  // always described.
  const unnamed = editableLayers(template.layers).filter((layer) => !isNamed(layer));

  if (unnamed.length > 0) {
    throw new BusinessRuleError(
      `${unnamed.length === 1 ? 'One editable layer has' : `${unnamed.length} editable layers have`} ` +
        'no field name. Give each one a merge field or a form label in the builder, so the ' +
        'buyer knows what to enter — otherwise they see a box labelled with the shape type.',
      { details: { layerIds: unnamed.map((layer) => layer.id) } },
    );
  }
}

/** The longest a single personalised value may be. */
export const MAX_FIELD_LENGTH = 2000;

/**
 * Checks a buyer's personalisation against the template they are ordering from,
 * and returns only the values that template actually accepts.
 *
 * ---------------------------------------------------------------------------
 * This is the boundary, not a convenience
 * ---------------------------------------------------------------------------
 * The customiser is a web page, and a web page can be made to send anything. If
 * a locked layer's key were accepted here, a buyer could rewrite the brand
 * colour band, the disclaimer, the price — anything the designer deliberately
 * held back — and the order would go to print carrying it. So this returns a
 * *rebuilt* record rather than validating and passing the caller's object
 * through: an unknown key cannot survive a rebuild by accident the way it can
 * survive a check somebody later forgets to run.
 *
 * Rejecting rather than dropping is deliberate too. A value silently discarded
 * is a buyer who thinks they set their phone number and receives five hundred
 * flyers without it.
 */
export function acceptCustomisation(
  layers: readonly TemplateLayerLike[],
  submitted: Readonly<Record<string, unknown>>,
): Record<string, string> {
  const editable = new Map(editableLayers(layers).map((layer) => [editableFieldKey(layer), layer]));

  // `Object.keys` is already own-properties-only, which is what makes the
  // unknown-key rejection below trustworthy.
  for (const key of Object.keys(submitted)) {
    const layer = editable.get(key);
    if (layer) continue;

    // Two different mistakes, and telling them apart is what makes the message
    // useful: a typo in a field name, versus an attempt at a locked layer.
    const locked = layers.find(
      (candidate) => !candidate.isEditableBySiteUser && editableFieldKey(candidate) === key,
    );

    throw new BusinessRuleError(
      locked
        ? `"${locked.label || locked.name}" is not editable on this template.`
        : `This template has no editable field called "${key}".`,
      { details: { fieldKey: key } },
    );
  }

  const accepted: Record<string, string> = {};

  for (const [key, layer] of editable) {
    // Own properties only. `submitted` arrives from JSON so it is a plain
    // object in practice, but this loop asks the *template* for a key and looks
    // it up on the caller's object — the one direction in which an inherited
    // property would be read as if the buyer had sent it. Checking is one call
    // and removes the question.
    const raw = Object.prototype.hasOwnProperty.call(submitted, key) ? submitted[key] : undefined;

    if (raw === undefined || raw === null || raw === '') {
      if (layer.isRequired) {
        throw new BusinessRuleError(`"${layer.label || layer.name}" is required.`, {
          details: { fieldKey: key },
        });
      }
      // Left out entirely rather than stored as an empty string, so "the buyer
      // cleared this" and "the buyer never saw this" stay distinguishable.
      continue;
    }

    if (typeof raw !== 'string') {
      throw new BusinessRuleError(`"${layer.label || layer.name}" must be text.`, {
        details: { fieldKey: key, received: typeof raw },
      });
    }

    if (raw.length > MAX_FIELD_LENGTH) {
      throw new BusinessRuleError(
        `"${layer.label || layer.name}" is longer than ${MAX_FIELD_LENGTH} characters.`,
        { details: { fieldKey: key, length: raw.length } },
      );
    }

    accepted[key] = raw;
  }

  return accepted;
}
