// Test helper — reports every icon-font element in a Vue SFC: which font
// class it carries, and the literal text the ligature has to resolve from.
//
// Material Icons and Material Symbols pick a glyph from the element's own
// text. A name the font doesn't know never forms a ligature, so the
// browser typesets the letters instead — invisible, but full width, and a
// single unbreakable word that no amount of missing room can shrink
// (#2605: `progress_activity` measured 408px instead of 24px).
//
// Parsing with Vue's own compiler keeps the class/text PAIRING under test.
// A source grep would see the class and the name on separate lines and
// have no way to tell whether they belong to the same element.

import { parse } from "vue/compiler-sfc";

const NODE_TYPE_ELEMENT = 1;
const NODE_TYPE_TEXT = 2;
const NODE_TYPE_ATTRIBUTE = 6;

type SfcTemplateAst = NonNullable<NonNullable<ReturnType<typeof parse>["descriptor"]["template"]>["ast"]>;
type TemplateChild = SfcTemplateAst["children"][number];
type ElementNode = Extract<TemplateChild, { type: typeof NODE_TYPE_ELEMENT }>;
type ElementProp = ElementNode["props"][number];
type AttributeNode = Extract<ElementProp, { type: typeof NODE_TYPE_ATTRIBUTE }>;

/** The two icon fonts the app loads (`src/main.ts`). */
export const ICON_FONT_CLASSES = ["material-icons", "material-symbols-outlined"] as const;

export type IconFontClass = (typeof ICON_FONT_CLASSES)[number];

export interface IconElement {
  fontClass: IconFontClass;
  /** The literal icon name, or `null` when the text is interpolated —
   *  `{{ action.icon }}` comes from schema data and is not knowable here. */
  name: string | null;
}

const isAttribute = (prop: ElementProp): prop is AttributeNode => prop.type === NODE_TYPE_ATTRIBUTE;
const isElement = (node: TemplateChild): node is ElementNode => node.type === NODE_TYPE_ELEMENT;

const staticClasses = (element: ElementNode): string[] => {
  const attr = element.props.filter(isAttribute).find((prop) => prop.name === "class");
  return attr?.value?.content.split(/\s+/) ?? [];
};

// Only a lone text child can be an icon name. Anything else — an
// interpolation, several children, an element — is either data-driven or
// not an icon at all, and reports as "no static name".
const staticText = (element: ElementNode): string | null => {
  const [only] = element.children;
  if (element.children.length !== 1 || only === undefined) return null;
  return only.type === NODE_TYPE_TEXT ? only.content.trim() : null;
};

const collect = (node: TemplateChild, found: IconElement[]): void => {
  if (!isElement(node)) return;
  const classes = staticClasses(node);
  const fontClass = ICON_FONT_CLASSES.find((candidate) => classes.includes(candidate));
  if (fontClass !== undefined) found.push({ fontClass, name: staticText(node) });
  node.children.forEach((child) => collect(child, found));
};

/** Every icon-font element in the SFC, in template order. */
export function findIconElements(sfcSource: string): IconElement[] {
  const { descriptor, errors } = parse(sfcSource);
  if (errors.length > 0) {
    throw new Error(`SFC parse failed: ${errors.map((error) => error.message).join("; ")}`);
  }
  const ast = descriptor.template?.ast;
  if (ast === undefined) return [];
  const found: IconElement[] = [];
  ast.children.forEach((child) => collect(child, found));
  return found;
}
