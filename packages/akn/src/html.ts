import { isElement, type AknDocument, type AknNode } from './types.ts';

// AKN → HTML.
//
// The element names are emitted verbatim: an `<article>` in the XML becomes an
// `<article>` in the HTML, an `<aknP>` becomes an `<aknP>`. Browsers accept
// unknown tags and expose them to CSS like any other element, so the whole AKN
// vocabulary is styleable without a translation layer inventing `<div class>`
// wrappers that the stylesheet would then have to guess its way back through.
//
// This is the same choice LEOS makes in its own HTML renditions, and it is what
// lets one stylesheet drive both the on-screen editor and the printed act. The
// cost is that unknown elements default to `display: inline`, so the stylesheet
// carries the entire block/inline structure of the vocabulary. That is a real
// obligation, not an oversight: see packages/pdf/src/css/act.css, where every
// structural element is given an explicit display.

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;');
}

/**
 * A handful of AKN element names collide with HTML elements that browsers
 * treat specially, and emitting them verbatim corrupts the document before any
 * stylesheet gets a say. They are renamed on the way out.
 *
 * `p` is the dangerous one. HTML forbids a `<p>` inside a `<p>` and closes the
 * outer one the instant the inner one opens. A citation is exactly that shape —
 *
 *     <p>Having regard to the opinion<authorialNote><p>OJ C 1.</p></authorialNote>,</p>
 *
 * — so the parser ends the citation early, promotes the note text to a sibling
 * block, and strands the trailing comma on a line of its own. The note is torn
 * out of the sentence it belongs to before rendering even begins.
 *
 * `body` nested inside the document body is dropped outright, and `title` is
 * parsed as document metadata rather than content.
 *
 * LEOS applies the same three renames in its own AKN→HTML mapper
 * (akn_xml_mapper.ftl), for the same reasons.
 */
const ELEMENT_RENAMES: Readonly<Record<string, string>> = {
  p: 'aknP',
  body: 'aknBody',
  title: 'aknTitle',
};

/**
 * Elements dropped entirely rather than hidden with CSS. Metadata travels with
 * the document but is not content, and leaving it in the render tree means one
 * missing `display: none` away from printing identifiers on the face of an act.
 */
const IGNORED_ELEMENTS = new Set(['meta']);

/**
 * Attributes worth carrying into the HTML. The rest — LEOS editing flags,
 * internal bookkeeping — have no bearing on how the document prints, and
 * dropping them keeps the render tree honest about what actually affects
 * layout.
 *
 * `name` earns its place: AKN reuses generic wrappers (`container`, `formula`,
 * `block`) and distinguishes them only by this attribute, so the stylesheet
 * addresses them as `formula[name="enactingFormula"]`. Without it every
 * wrapper in the document styles identically.
 */
const RENDERED_ATTRS = new Set([
  'name',
  'marker',
  'refersTo',
  'href',
  'src',
  'alt',
  'date',
  'class',
]);

/**
 * Element names that the browser treats as executable or as a network fetch.
 *
 * AKN is an open vocabulary and this renderer emits element names verbatim,
 * which is what lets the stylesheet own the vocabulary. The cost is that
 * anything an editor can put in the document tree becomes a real HTML tag —
 * so `<script>`, `<iframe>` or an `<img src>` pointing anywhere would be
 * executed or fetched by the Chromium that renders the export.
 *
 * These names are neutralised rather than dropped: the content stays visible
 * in the document (silently deleting a provision is worse than showing an
 * inert one), but it is emitted under a prefixed name the browser has no
 * behaviour for.
 */
const ACTIVE_ELEMENTS = new Set([
  'script',
  'iframe',
  'object',
  'embed',
  'applet',
  'link',
  'meta',
  'base',
  'form',
  'input',
  'button',
  'textarea',
  'select',
  'option',
  'style',
  'svg',
  'math',
  'audio',
  'video',
  'source',
  'track',
  'portal',
  'frame',
  'frameset',
  'noscript',
  'template',
  'slot',
  'img',
  'picture',
  'canvas',
  'marquee',
  'dialog',
]);

/**
 * A URL safe to leave in a rendered attribute.
 *
 * Anything that can execute (`javascript:`), carry a payload (`data:`), or
 * reach the network from inside the renderer is refused. The renderer runs
 * Chromium without a sandbox; a document should not be able to make it fetch.
 */
function safeUrl(value: string): string | null {
  const trimmed = value.trim();
  // An allowlist of exactly one shape, rather than a list of things to block.
  //
  // A document fragment resolves inside the page and reaches nothing, which
  // is the only linking an exported PDF needs — a cross-reference to another
  // provision. Everything else is refused without inspection: no scheme to
  // classify, no host to compare, nothing to get subtly wrong. Blocklists of
  // `javascript:` and `//host` invite exactly that kind of near-miss.
  return /^#[\w.:-]+$/.test(trimmed) ? trimmed : null;
}

function renderNode(node: AknNode): string {
  if (!isElement(node)) return escapeText(node.text);
  if (IGNORED_ELEMENTS.has(node.name)) return '';

  const renamed = ELEMENT_RENAMES[node.name] ?? node.name;
  // An element the browser would act on is emitted under a name it has no
  // behaviour for. Prefixed rather than dropped so the text still prints.
  const active = ACTIVE_ELEMENTS.has(renamed.toLowerCase());
  const tag = active ? `akn-${renamed.toLowerCase()}` : renamed;

  const attrs: string[] = [];
  if (node.id) attrs.push(`id="${escapeAttr(node.id)}"`);
  for (const [key, value] of Object.entries(node.attrs)) {
    if (!RENDERED_ATTRS.has(key)) continue;
    if (key === 'href' || key === 'src') {
      const url = safeUrl(value);
      if (url === null) continue;
      attrs.push(`${key}="${escapeAttr(url)}"`);
      continue;
    }
    attrs.push(`${key}="${escapeAttr(value)}"`);
  }

  const open = attrs.length ? `${tag} ${attrs.join(' ')}` : tag;
  const inner = node.children.map(renderNode).join('');
  // Always emit a closing tag. Unknown self-closed elements (`<num/>`) are
  // parsed by browsers as an unclosed *open* tag, which swallows the rest of
  // the document into it — an empty `<num>` would eat the article it labels.
  return `<${open}>${inner}</${tag}>`;
}

/** Render a document's body to an HTML fragment. */
export function toHtml(doc: AknDocument): string {
  return renderNode(doc.root);
}
