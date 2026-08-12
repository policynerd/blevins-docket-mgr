// The Akoma Ntoso document tree.
//
// AKN is an open vocabulary: OASIS defines the element names, but a document is
// just a tree of named elements carrying stable identifiers. We model that
// substrate directly rather than generating one interface per element type,
// because that is what the format actually is — and because it is what makes
// the rendering pipeline work.
//
// LEOS reaches the same conclusion from the other direction. Their PDF exporter
// hands unknown AKN tags to iText's *generic* tag worker, resolved purely by the
// CSS `display` value the stylesheet assigns them (CustomTagWorkerFactory).
// Nothing in their renderer knows what an `<article>` is. The vocabulary lives
// in the stylesheet, not the code — so a new element type is a CSS rule, not a
// code change. We keep that property deliberately.

/** A node is either an element or a run of text. */
export type AknNode = AknElement | AknText;

export interface AknText {
  readonly kind: 'text';
  readonly text: string;
}

export interface AknElement {
  readonly kind: 'element';
  /** The AKN element name, e.g. `article`, `aknP`, `authorialNote`. */
  readonly name: string;
  /**
   * Stable identifier. Every structural element carries one so a comment, a
   * cross-reference, or an amending instruction can target a provision and keep
   * resolving as the surrounding text is edited. Inline formatting (`<i>`, a
   * `<b>` run) is exempt — it has nothing to anchor.
   */
  readonly id?: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: readonly AknNode[];
}

export function text(value: string): AknText {
  return { kind: 'text', text: value };
}

export function element(
  name: string,
  opts: {
    id?: string;
    attrs?: Record<string, string>;
    children?: readonly AknNode[];
  } = {},
): AknElement {
  return {
    kind: 'element',
    name,
    id: opts.id,
    attrs: opts.attrs ?? {},
    children: opts.children ?? [],
  };
}

export function isElement(node: AknNode): node is AknElement {
  return node.kind === 'element';
}

export function isText(node: AknNode): node is AknText {
  return node.kind === 'text';
}

/**
 * The document types this system issues. These mirror the parts LEOS tracks as
 * independent drafts under one proposal — each is separately edited, versioned
 * and rendered, and they are merged into a single PDF only at export.
 */
export const DOC_TYPES = [
  'COVER_PAGE',
  'EXPL_MEMORANDUM',
  'LEGAL_ACT',
  'FINANCIAL_STATEMENT',
  'ANNEX',
] as const;

export type DocType = (typeof DOC_TYPES)[number];

/**
 * The AKN root wrapper each document type uses. AKN distinguishes a normative
 * act (`bill`) from an explanatory document (`doc`) from a collection wrapper
 * (`documentCollection`) at the root, and the stylesheets key off it.
 */
export const ROOT_ELEMENT: Record<DocType, string> = {
  COVER_PAGE: 'documentCollection',
  EXPL_MEMORANDUM: 'doc',
  LEGAL_ACT: 'bill',
  FINANCIAL_STATEMENT: 'doc',
  ANNEX: 'doc',
};

export interface AknDocument {
  readonly docType: DocType;
  /** The root element beneath `<akomaNtoso>`. */
  readonly root: AknElement;
}

export const AKN_NS = 'http://docs.oasis-open.org/legaldocml/ns/akn/3.0';
/**
 * LEOS's own extension namespace. We keep the prefix and URI they use so a
 * document produced here opens in LEOS without a namespace rewrite — the
 * editability flags (`leos:editable`, `leos:deletable`) ride on it.
 */
export const LEOS_NS = 'urn:eu:europa:ec:leos';
