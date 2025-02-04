import { upperFirst, capitalize, last, pick, compose, evolve, mapValues, matchPercent, isNil, get, castArray, omit, asyncCompose } from '@react-pdf/fns';
import * as P from '@react-pdf/primitives';
import { TextInstance } from '@react-pdf/primitives';
import stylesheet, { transformColor, processTransform, flatten } from '@react-pdf/stylesheet';
import layoutEngine, { bidi, linebreaker, justification, textDecoration, scriptItemizer, wordHyphenation } from '@react-pdf/textkit';
import { PDFFont } from '@react-pdf/pdfkit';
import * as Yoga from 'yoga-layout/load';
import { loadYoga as loadYoga$1 } from 'yoga-layout/load';
import emojiRegex from 'emoji-regex';
import resolveImage from '@react-pdf/image';

/**
 * Create attributed string from text fragments
 *
 * @param {Object[]} fragments fragments
 * @returns {Object} attributed string
 */
const fromFragments = fragments => {
  let offset = 0;
  let string = '';
  const runs = [];
  fragments.forEach(fragment => {
    string += fragment.string;
    runs.push({
      start: offset,
      end: offset + fragment.string.length,
      attributes: fragment.attributes || {}
    });
    offset += fragment.string.length;
  });
  return {
    string,
    runs
  };
};

/**
 * Apply transformation to text string
 *
 * @param {string} text
 * @param {string} transformation type
 * @returns {string} transformed text
 */
const transformText = (text, transformation) => {
  switch (transformation) {
    case 'uppercase':
      return text.toUpperCase();
    case 'lowercase':
      return text.toLowerCase();
    case 'capitalize':
      return capitalize(text);
    case 'upperfirst':
      return upperFirst(text);
    default:
      return text;
  }
};

/* eslint-disable class-methods-use-this */

class StandardFont {
  constructor(src) {
    this.name = src;
    this.src = PDFFont.open(null, src);
  }
  encode(str) {
    return this.src.encode(str);
  }
  layout(str) {
    const [encoded, positions] = this.encode(str);
    return {
      positions,
      stringIndices: positions.map((_, i) => i),
      glyphs: encoded.map((g, i) => {
        const glyph = this.getGlyph(parseInt(g, 16));
        glyph.advanceWidth = positions[i].advanceWidth;
        return glyph;
      })
    };
  }
  glyphForCodePoint(codePoint) {
    const glyph = this.getGlyph(codePoint);
    glyph.advanceWidth = 400;
    return glyph;
  }
  getGlyph(id) {
    return {
      id,
      _font: this.src,
      codePoints: [id],
      isLigature: false,
      name: this.src.font.characterToGlyph(id)
    };
  }
  hasGlyphForCodePoint(codePoint) {
    return this.src.font.characterToGlyph(codePoint) !== '.notdef';
  }

  // Based on empirical observation
  get ascent() {
    return 900;
  }

  // Based on empirical observation
  get capHeight() {
    switch (this.name) {
      case 'Times-Roman':
      case 'Times-Bold':
      case 'Times-Italic':
      case 'Times-BoldItalic':
        return 650;
      case 'Courier':
      case 'Courier-Bold':
      case 'Courier-Oblique':
      case 'Courier-BoldOblique':
        return 550;
      default:
        return 690;
    }
  }

  // Based on empirical observation
  get xHeight() {
    switch (this.name) {
      case 'Times-Roman':
      case 'Times-Bold':
      case 'Times-Italic':
      case 'Times-BoldItalic':
        return 440;
      case 'Courier':
      case 'Courier-Bold':
      case 'Courier-Oblique':
      case 'Courier-BoldOblique':
        return 390;
      default:
        return 490;
    }
  }

  // Based on empirical observation
  get descent() {
    switch (this.name) {
      case 'Times-Roman':
      case 'Times-Bold':
      case 'Times-Italic':
      case 'Times-BoldItalic':
        return -220;
      case 'Courier':
      case 'Courier-Bold':
      case 'Courier-Oblique':
      case 'Courier-BoldOblique':
        return -230;
      default:
        return -200;
    }
  }
  get lineGap() {
    return 0;
  }
  get unitsPerEm() {
    return 1000;
  }
}

const fontCache = {};
const IGNORED_CODE_POINTS = [173];
const getFontSize = node => node.attributes.fontSize || 12;
const getOrCreateFont = name => {
  if (fontCache[name]) return fontCache[name];
  const font = new StandardFont(name);
  fontCache[name] = font;
  return font;
};
const getFallbackFont = () => getOrCreateFont('Helvetica');
const pickFontFromFontStack = (codePoint, fontStack, lastFont) => {
  const fontStackWithFallback = [...fontStack, lastFont, getFallbackFont()];
  for (let i = 0; i < fontStackWithFallback.length; i += 1) {
    const font = fontStackWithFallback[i];
    if (!IGNORED_CODE_POINTS.includes(codePoint) && font && font.hasGlyphForCodePoint && font.hasGlyphForCodePoint(codePoint)) {
      return font;
    }
  }
  return getFallbackFont();
};
const fontSubstitution = () => _ref => {
  let {
    string,
    runs
  } = _ref;
  let lastFont = null;
  let lastFontSize = null;
  let lastIndex = 0;
  let index = 0;
  const res = [];
  for (let i = 0; i < runs.length; i += 1) {
    const run = runs[i];
    const defaultFont = run.attributes.font.map(font => typeof font === 'string' ? getOrCreateFont(font) : font);
    if (string.length === 0) {
      res.push({
        start: 0,
        end: 0,
        attributes: {
          font: defaultFont
        }
      });
      break;
    }
    const chars = string.slice(run.start, run.end);
    for (let j = 0; j < chars.length; j += 1) {
      const char = chars[j];
      const codePoint = char.codePointAt();
      // If the default font does not have a glyph and the fallback font does, we use it
      const font = pickFontFromFontStack(codePoint, defaultFont, lastFont);
      const fontSize = getFontSize(run);

      // If anything that would impact res has changed, update it
      if (font !== lastFont || fontSize !== lastFontSize || font.unitsPerEm !== lastFont.unitsPerEm) {
        if (lastFont) {
          res.push({
            start: lastIndex,
            end: index,
            attributes: {
              font: lastFont,
              scale: lastFontSize / lastFont.unitsPerEm
            }
          });
        }
        lastFont = font;
        lastFontSize = fontSize;
        lastIndex = index;
      }
      index += char.length;
    }
  }
  if (lastIndex < string.length) {
    const fontSize = getFontSize(last(runs));
    res.push({
      start: lastIndex,
      end: string.length,
      attributes: {
        font: lastFont,
        scale: fontSize / lastFont.unitsPerEm
      }
    });
  }
  return {
    string,
    runs: res
  };
};

const isTextInstance$4 = node => node.type === P.TextInstance;
const engines$1 = {
  bidi,
  linebreaker,
  justification,
  textDecoration,
  scriptItemizer,
  wordHyphenation,
  fontSubstitution
};
const engine$1 = layoutEngine(engines$1);
const getFragments$1 = (fontStore, instance) => {
  if (!instance) return [{
    string: ''
  }];
  const fragments = [];
  const {
    fill = 'black',
    fontFamily = 'Helvetica',
    fontWeight,
    fontStyle,
    fontSize = 18,
    textDecorationColor,
    textDecorationStyle,
    textTransform,
    opacity
  } = instance.props;
  const _textDecoration = instance.props.textDecoration;
  const fontFamilies = typeof fontFamily === 'string' ? [fontFamily] : [...(fontFamily || [])];
  const font = fontFamilies.map(fontFamilyName => {
    if (typeof fontFamilyName !== 'string') return fontFamilyName;
    const opts = {
      fontFamily: fontFamilyName,
      fontWeight,
      fontStyle
    };
    const obj = fontStore ? fontStore.getFont(opts) : null;
    return obj ? obj.data : fontFamilyName;
  });
  const attributes = {
    font,
    opacity,
    fontSize,
    color: fill,
    underlineStyle: textDecorationStyle,
    underline: _textDecoration === 'underline' || _textDecoration === 'underline line-through' || _textDecoration === 'line-through underline',
    underlineColor: textDecorationColor || fill,
    strike: _textDecoration === 'line-through' || _textDecoration === 'underline line-through' || _textDecoration === 'line-through underline',
    strikeStyle: textDecorationStyle,
    strikeColor: textDecorationColor || fill
  };
  for (let i = 0; i < instance.children.length; i += 1) {
    const child = instance.children[i];
    if (isTextInstance$4(child)) {
      fragments.push({
        string: transformText(child.value, textTransform),
        attributes
      });
    } else if (child) {
      fragments.push(...getFragments$1(child));
    }
  }
  return fragments;
};
const getAttributedString$1 = (fontStore, instance) => fromFragments(getFragments$1(fontStore, instance));
const AlmostInfinity = 999999999999;
const shrinkWhitespaceFactor = {
  before: -0.5,
  after: -0.5
};
const layoutTspan = fontStore => node => {
  var _node$props, _node$props2;
  const attributedString = getAttributedString$1(fontStore, node);
  const x = ((_node$props = node.props) === null || _node$props === void 0 ? void 0 : _node$props.x) || 0;
  const y = ((_node$props2 = node.props) === null || _node$props2 === void 0 ? void 0 : _node$props2.y) || 0;
  const container = {
    x,
    y,
    width: AlmostInfinity,
    height: AlmostInfinity
  };
  const hyphenationCallback = node.props.hyphenationCallback || (fontStore === null || fontStore === void 0 ? void 0 : fontStore.getHyphenationCallback()) || null;
  const layoutOptions = {
    hyphenationCallback,
    shrinkWhitespaceFactor
  };
  const lines = engine$1(attributedString, container, layoutOptions).flat();
  return Object.assign({}, node, {
    lines
  });
};
const layoutText$1 = (fontStore, node) => {
  if (!node.children) return node;
  const children = node.children.map(layoutTspan(fontStore));
  return Object.assign({}, node, {
    children
  });
};

const isDefs = node => node.type === P.Defs;
const getDefs = node => {
  const children = node.children || [];
  const defs = children.find(isDefs) || {};
  const values = defs.children || [];
  return values.reduce((acc, value) => {
    var _value$props;
    const id = (_value$props = value.props) === null || _value$props === void 0 ? void 0 : _value$props.id;
    if (id) acc[id] = value;
    return acc;
  }, {});
};

const isNotDefs = node => node.type !== P.Defs;
const detachDefs = node => {
  if (!node.children) return node;
  const children = node.children.filter(isNotDefs);
  return Object.assign({}, node, {
    children
  });
};
const URL_REGEX = /url\(['"]?#([^'"]+)['"]?\)/;
const replaceDef = (defs, value) => {
  if (!value) return undefined;
  if (!URL_REGEX.test(value)) return value;
  const match = value.match(URL_REGEX);
  return defs[match[1]];
};
const parseNodeDefs = defs => node => {
  var _node$props, _node$props2;
  const fill = replaceDef(defs, (_node$props = node.props) === null || _node$props === void 0 ? void 0 : _node$props.fill);
  const clipPath = replaceDef(defs, (_node$props2 = node.props) === null || _node$props2 === void 0 ? void 0 : _node$props2.clipPath);
  const props = Object.assign({}, node.props, {
    fill,
    clipPath
  });
  const children = node.children ? node.children.map(parseNodeDefs(defs)) : undefined;
  return Object.assign({}, node, {
    props,
    children
  });
};
const parseDefs = root => {
  if (!root.children) return root;
  const defs = getDefs(root);
  const children = root.children.map(parseNodeDefs(defs));
  return Object.assign({}, root, {
    children
  });
};
const replaceDefs = node => {
  return detachDefs(parseDefs(node));
};

const parseViewbox = value => {
  if (!value) return null;
  const values = value.split(/[,\s]+/).map(parseFloat);
  if (values.length !== 4) return null;
  return {
    minX: values[0],
    minY: values[1],
    maxX: values[2],
    maxY: values[3]
  };
};

const getContainer$1 = node => {
  const viewbox = parseViewbox(node.props.viewBox);
  if (viewbox) {
    return {
      width: viewbox.maxX,
      height: viewbox.maxY
    };
  }
  if (node.props.width && node.props.height) {
    return {
      width: parseFloat(node.props.width),
      height: parseFloat(node.props.height)
    };
  }
  return {
    width: 0,
    height: 0
  };
};

const SVG_INHERITED_PROPS = ['x', 'y', 'clipPath', 'clipRule', 'opacity', 'fill', 'fillOpacity', 'fillRule', 'stroke', 'strokeLinecap', 'strokeLinejoin', 'strokeOpacity', 'strokeWidth', 'textAnchor', 'dominantBaseline', 'color', 'fontFamily', 'fontSize', 'fontStyle', 'fontWeight', 'letterSpacing', 'opacity', 'textDecoration', 'lineHeight', 'textAlign', 'visibility', 'wordSpacing'];
const getInheritProps = node => {
  const props = node.props || {};
  return pick(SVG_INHERITED_PROPS, props);
};
const inheritProps = node => {
  if (!node.children) return node;
  const inheritedProps = getInheritProps(node);
  const children = node.children.map(child => {
    const props = Object.assign({}, inheritedProps, child.props || {});
    const newChild = Object.assign({}, child, {
      props
    });
    return inheritProps(newChild);
  });
  return Object.assign({}, node, {
    children
  });
};

const parseAspectRatio = value => {
  const match = value.replace(/[\s\r\t\n]+/gm, ' ').replace(/^defer\s/, '').split(' ');
  const align = match[0] || 'xMidYMid';
  const meetOrSlice = match[1] || 'meet';
  return {
    align,
    meetOrSlice
  };
};

const STYLE_PROPS = ['width', 'height', 'color', 'stroke', 'strokeWidth', 'opacity', 'fillOpacity', 'strokeOpacity', 'fill', 'fillRule', 'clipPath', 'offset', 'transform', 'strokeLinejoin', 'strokeLinecap', 'strokeDasharray'];
const VERTICAL_PROPS = ['y', 'y1', 'y2', 'height', 'cy', 'ry'];
const HORIZONTAL_PROPS = ['x', 'x1', 'x2', 'width', 'cx', 'rx'];
const isType$3 = type => node => node.type === type;
const isSvg$3 = isType$3(P.Svg);
const isText$5 = isType$3(P.Text);
const isTextInstance$3 = isType$3(P.TextInstance);
const transformPercent = container => props => mapValues(props, (value, key) => {
  const match = matchPercent(value);
  if (match && VERTICAL_PROPS.includes(key)) {
    return match.percent * container.height;
  }
  if (match && HORIZONTAL_PROPS.includes(key)) {
    return match.percent * container.width;
  }
  return value;
});
const parsePercent = value => {
  const match = matchPercent(value);
  return match ? match.percent : parseFloat(value);
};
const parseProps = container => node => {
  let props = transformPercent(container)(node.props);
  props = evolve({
    x: parseFloat,
    x1: parseFloat,
    x2: parseFloat,
    y: parseFloat,
    y1: parseFloat,
    y2: parseFloat,
    r: parseFloat,
    rx: parseFloat,
    ry: parseFloat,
    cx: parseFloat,
    cy: parseFloat,
    width: parseFloat,
    height: parseFloat,
    offset: parsePercent,
    fill: transformColor,
    opacity: parsePercent,
    stroke: transformColor,
    stopOpacity: parsePercent,
    stopColor: transformColor,
    transform: processTransform
  }, props);
  return Object.assign({}, node, {
    props
  });
};
const mergeStyles$1 = node => {
  const style = node.style || {};
  const props = Object.assign({}, style, node.props);
  return Object.assign({}, node, {
    props
  });
};
const removeNoneValues = node => {
  const removeNone = value => value === 'none' ? null : value;
  const props = mapValues(node.props, removeNone);
  return Object.assign({}, node, {
    props
  });
};
const pickStyleProps = node => {
  const props = node.props || {};
  const styleProps = pick(STYLE_PROPS, props);
  const style = Object.assign({}, styleProps, node.style || {});
  return Object.assign({}, node, {
    style
  });
};
const parseSvgProps = node => {
  const props = evolve({
    width: parseFloat,
    height: parseFloat,
    viewBox: parseViewbox,
    preserveAspectRatio: parseAspectRatio
  }, node.props);
  return Object.assign({}, node, {
    props
  });
};
const wrapBetweenTspan = node => ({
  type: P.Tspan,
  props: {},
  children: [node]
});
const addMissingTspan = node => {
  if (!isText$5(node)) return node;
  if (!node.children) return node;
  const resolveChild = child => isTextInstance$3(child) ? wrapBetweenTspan(child) : child;
  const children = node.children.map(resolveChild);
  return Object.assign({}, node, {
    children
  });
};
const parseText = fontStore => node => {
  if (isText$5(node)) return layoutText$1(fontStore, node);
  if (!node.children) return node;
  const children = node.children.map(parseText(fontStore));
  return Object.assign({}, node, {
    children
  });
};
const resolveSvgNode = container => compose(parseProps(container), addMissingTspan, removeNoneValues, mergeStyles$1);
const resolveChildren = container => node => {
  if (!node.children) return node;
  const resolveChild = compose(resolveChildren(container), resolveSvgNode(container));
  const children = node.children.map(resolveChild);
  return Object.assign({}, node, {
    children
  });
};
const resolveSvgRoot = (node, fontStore) => {
  const container = getContainer$1(node);
  return compose(replaceDefs, parseText(fontStore), parseSvgProps, pickStyleProps, inheritProps, resolveChildren(container))(node);
};

/**
 * Pre-process SVG nodes so they can be rendered in the next steps
 *
 * @param {Object} node root node
 * @param {Object} fontStore font store
 * @returns {Object} root node
 */
const resolveSvg = (node, fontStore) => {
  if (!node.children) return node;
  const resolveChild = child => resolveSvg(child, fontStore);
  const root = isSvg$3(node) ? resolveSvgRoot(node, fontStore) : node;
  const children = root.children.map(resolveChild);
  return Object.assign({}, root, {
    children
  });
};

/* eslint-disable import/prefer-default-export */

let globalInstance;
const loadYoga = async () => {
  // Yoga WASM binaries must be asynchronously compiled and loaded
  // to prevent Event emitter memory leak warnings, Yoga must be loaded only once
  const instance = await (globalInstance ??= loadYoga$1());
  const config = instance.Config.create();
  config.setPointScaleFactor(0);
  const node = {
    create: () => instance.Node.createWithConfig(config)
  };
  return {
    node
  };
};

const resolveYoga = async root => {
  const yoga = await loadYoga();
  return Object.assign({}, root, {
    yoga
  });
};

const getZIndex = node => node.style.zIndex;
const shouldSort = node => node.type !== P.Document && node.type !== P.Svg;
const sortZIndex = (a, b) => {
  const za = getZIndex(a);
  const zb = getZIndex(b);
  if (!za && !zb) return 0;
  if (!za) return 1;
  if (!zb) return -1;
  return zb - za;
};

/**
 * Sort children by zIndex value
 *
 * @param {Object} node
 * @returns {Object} node
 */
const resolveZIndex = node => {
  if (!node.children) return node;
  const sortedChildren = shouldSort(node) ? node.children.sort(sortZIndex) : node.children;
  const children = sortedChildren.map(resolveZIndex);
  return Object.assign({}, node, {
    children
  });
};

/* eslint-disable no-cond-assign */

// Caches emoji images data
const emojis = {};
const regex = emojiRegex();
const reflect = promise => function () {
  return promise(...arguments).then(v => v, e => e);
};

// Returns a function to be able to mock resolveImage.
const makeFetchEmojiImage = () => reflect(resolveImage);

/**
 * When an emoji as no variations, it might still have 2 parts,
 * the canonical emoji and an empty string.
 * ex.
 *   (no color) Array.from('❤️') => ["❤", "️"]
 *   (w/ color) Array.from('👍🏿') => ["👍", "🏿"]
 *
 * The empty string needs to be removed otherwise the generated
 * url will be incorect.
 */
const _removeVariationSelectors = x => x !== '️';
const getCodePoints = (string, withVariationSelectors) => Array.from(string).filter(withVariationSelectors ? () => true : _removeVariationSelectors).map(char => char.codePointAt(0).toString(16)).join('-');
const buildEmojiUrl = (emoji, source) => {
  const {
    url,
    format,
    builder,
    withVariationSelectors
  } = source;
  if (typeof builder === 'function') {
    return builder(getCodePoints(emoji, withVariationSelectors));
  }
  return `${url}${getCodePoints(emoji, withVariationSelectors)}.${format}`;
};
const fetchEmojis = (string, source) => {
  if (!source || !source.url && !source.builder) return [];
  const promises = [];
  Array.from(string.matchAll(regex)).forEach(match => {
    const emoji = match[0];
    if (!emojis[emoji] || emojis[emoji].loading) {
      const emojiUrl = buildEmojiUrl(emoji, source);
      emojis[emoji] = {
        loading: true
      };
      const fetchEmojiImage = makeFetchEmojiImage();
      promises.push(fetchEmojiImage({
        uri: emojiUrl
      }).then(image => {
        emojis[emoji].loading = false;
        emojis[emoji].data = image.data;
      }));
    }
  });
  return promises;
};
const specialCases = ['©️', '®', '™']; // Do not treat these as emojis if emoji not present

const embedEmojis = fragments => {
  const result = [];
  for (let i = 0; i < fragments.length; i += 1) {
    const fragment = fragments[i];
    let lastIndex = 0;
    Array.from(fragment.string.matchAll(regex)).forEach(match => {
      const {
        index
      } = match;
      const emoji = match[0];
      const isSpecialCase = specialCases.includes(emoji);
      const emojiSize = fragment.attributes.fontSize;
      const chunk = fragment.string.slice(lastIndex, index + match[0].length);

      // If emoji image was found, we create a new fragment with the
      // correct attachment and object substitution character;
      if (emojis[emoji] && emojis[emoji].data) {
        result.push({
          string: chunk.replace(match, String.fromCharCode(0xfffc)),
          attributes: {
            ...fragment.attributes,
            attachment: {
              width: emojiSize,
              height: emojiSize,
              yOffset: Math.floor(emojiSize * 0.1),
              image: emojis[emoji].data
            }
          }
        });
      } else if (isSpecialCase) {
        result.push({
          string: chunk,
          attributes: fragment.attributes
        });
      } else {
        // If no emoji data, we just replace the emoji with a nodef char
        result.push({
          string: chunk.replace(match, String.fromCharCode(0)),
          attributes: fragment.attributes
        });
      }
      lastIndex = index + emoji.length;
    });
    if (lastIndex < fragment.string.length) {
      result.push({
        string: fragment.string.slice(lastIndex),
        attributes: fragment.attributes
      });
    }
  }
  return result;
};

/**
 * Get image source
 *
 * @param {Object} node image node
 * @returns {string | Object} image src
 */
const getSource = node => {
  var _node$props, _node$props2, _node$props3;
  return ((_node$props = node.props) === null || _node$props === void 0 ? void 0 : _node$props.src) || ((_node$props2 = node.props) === null || _node$props2 === void 0 ? void 0 : _node$props2.source) || ((_node$props3 = node.props) === null || _node$props3 === void 0 ? void 0 : _node$props3.href);
};

/**
 * Resolves `src` to `@react-pdf/image` interface.
 *
 * Also it handles factories and async sources.
 *
 * @param {string | Object | Function} src
 * @returns {Promise<Object>} resolved src
 */
const resolveSource = async src => {
  const source = typeof src === 'function' ? await src() : await src;
  return typeof source === 'string' ? {
    uri: source
  } : source;
};

/* eslint-disable no-param-reassign */


/**
 * Fetches image and append data to node
 * Ideally this fn should be immutable.
 *
 * @param {Object} node
 */
const fetchImage = async node => {
  const src = getSource(node);
  const {
    cache
  } = node.props;
  if (!src) {
    console.warn(false, 'Image should receive either a "src" or "source" prop');
    return;
  }
  try {
    const source = await resolveSource(src);
    if (!source) {
      throw new Error(`Image's "src" or "source" prop returned ${source}`);
    }
    node.image = await resolveImage(source, {
      cache
    });
    node.image.key = source.data ? source.data.toString() : source.uri;
  } catch (e) {
    node.image = {
      width: 0,
      height: 0,
      key: null
    };
    console.warn(e.message);
  }
};

const isImage$2 = node => node.type === P.Image;

/**
 * Get all asset promises that need to be resolved
 *
 * @param {Object} fontStore font store
 * @param {Object} node root node
 * @returns {Promise<void>[]} asset promises
 */
const fetchAssets = (fontStore, node) => {
  var _node$children;
  const promises = [];
  const listToExplore = ((_node$children = node.children) === null || _node$children === void 0 ? void 0 : _node$children.slice(0)) || [];
  const emojiSource = fontStore ? fontStore.getEmojiSource() : null;
  while (listToExplore.length > 0) {
    var _n$style;
    const n = listToExplore.shift();
    if (isImage$2(n)) {
      promises.push(fetchImage(n));
    }
    if (fontStore && (_n$style = n.style) !== null && _n$style !== void 0 && _n$style.fontFamily) {
      promises.push(fontStore.load(n.style));
    }
    if (typeof n === 'string') {
      promises.push(...fetchEmojis(n, emojiSource));
    }
    if (typeof n.value === 'string') {
      promises.push(...fetchEmojis(n.value, emojiSource));
    }
    if (n.children) {
      n.children.forEach(childNode => {
        listToExplore.push(childNode);
      });
    }
  }
  return promises;
};

/**
 * Fetch image, font and emoji assets in parallel.
 * Layout process will not be resumed until promise resolves.
 *
 * @param {Object} node root node
 * @param {Object} fontStore font store
 * @returns {Promise<Object>} root node
 */
const resolveAssets = async (node, fontStore) => {
  const promises = fetchAssets(fontStore, node);
  await Promise.all(promises);
  return node;
};

const isLink$1 = node => node.type === P.Link;
const DEFAULT_LINK_STYLES = {
  color: 'blue',
  textDecoration: 'underline'
};

/**
 * Computes styles using stylesheet
 *
 * @param {Object} container
 * @param {Object} node document node
 * @returns {Object} computed styles
 */
const computeStyle = (container, node) => {
  let baseStyle = node.style;
  if (isLink$1(node)) {
    baseStyle = Array.isArray(node.style) ? [DEFAULT_LINK_STYLES, ...node.style] : [DEFAULT_LINK_STYLES, node.style];
  }
  return stylesheet(container, baseStyle);
};

/**
 * @typedef {Function} ResolveNodeStyles
 * @param {Object} node document node
 * @returns {Object} node (and subnodes) with resolved styles
 */

/**
 * Resolves node styles
 *
 * @param {Object} container
 * @returns {ResolveNodeStyles} resolve node styles
 */
const resolveNodeStyles = container => node => {
  const style = computeStyle(container, node);
  if (!node.children) return Object.assign({}, node, {
    style
  });
  const children = node.children.map(resolveNodeStyles(container));
  return Object.assign({}, node, {
    style,
    children
  });
};

/**
 * Resolves page styles
 *
 * @param {Object} page document page
 * @returns {Object} document page with resolved styles
 */
const resolvePageStyles = page => {
  var _page$box, _page$box2, _page$props;
  const dpi = 72; // Removed: page.props?.dpi || 72;
  const width = ((_page$box = page.box) === null || _page$box === void 0 ? void 0 : _page$box.width) || page.style.width;
  const height = ((_page$box2 = page.box) === null || _page$box2 === void 0 ? void 0 : _page$box2.height) || page.style.height;
  const orientation = ((_page$props = page.props) === null || _page$props === void 0 ? void 0 : _page$props.orientation) || 'portrait';
  const container = {
    width,
    height,
    orientation,
    dpi
  };
  return resolveNodeStyles(container)(page);
};

/**
 * Resolves document styles
 *
 * @param {Object} root document root
 * @returns {Object} document root with resolved styles
 */
const resolveStyles = root => {
  if (!root.children) return root;
  const children = root.children.map(resolvePageStyles);
  return Object.assign({}, root, {
    children
  });
};

const getTransformStyle = s => node => {
  var _node$style, _node$style2;
  return isNil((_node$style = node.style) === null || _node$style === void 0 ? void 0 : _node$style[s]) ? '50%' : (_node$style2 = node.style) === null || _node$style2 === void 0 ? void 0 : _node$style2[s];
};

/**
 * Get node origin
 *
 * @param {Object} node
 * @returns {{ left?: number, top?: number }} node origin
 */
const getOrigin = node => {
  if (!node.box) return {};
  const {
    left,
    top,
    width,
    height
  } = node.box;
  const transformOriginX = getTransformStyle('transformOriginX')(node);
  const transformOriginY = getTransformStyle('transformOriginY')(node);
  const percentX = matchPercent(transformOriginX);
  const percentY = matchPercent(transformOriginY);
  const offsetX = percentX ? width * percentX.percent : transformOriginX;
  const offsetY = percentY ? height * percentY.percent : transformOriginY;
  return {
    left: left + offsetX,
    top: top + offsetY
  };
};

/**
 * Resolve node origin
 *
 * @param {Object} node
 * @returns {Object} node with origin attribute
 */
const resolveNodeOrigin = node => {
  const origin = getOrigin(node);
  const newNode = Object.assign({}, node, {
    origin
  });
  if (!node.children) return newNode;
  const children = node.children.map(resolveNodeOrigin);
  return Object.assign({}, newNode, {
    children
  });
};

/**
 * Resolve document origins
 *
 * @param {Object} root document root
 * @returns {Object} document root
 */

const resolveOrigin = root => {
  if (!root.children) return root;
  const children = root.children.map(resolveNodeOrigin);
  return Object.assign({}, root, {
    children
  });
};

/* eslint-disable no-plusplus */
/* eslint-disable prefer-const */
/* eslint-disable prefer-destructuring */

const getBookmarkValue = title => {
  return typeof title === 'string' ? {
    title,
    fit: false,
    expanded: false
  } : title;
};
const resolveBookmarks = node => {
  let refs = 0;
  const children = (node.children || []).slice(0);
  const listToExplore = children.map(value => ({
    value,
    parent: null
  }));
  while (listToExplore.length > 0) {
    var _child$props;
    const element = listToExplore.shift();
    const child = element.value;
    let parent = element.parent;
    if ((_child$props = child.props) !== null && _child$props !== void 0 && _child$props.bookmark) {
      var _parent;
      const bookmark = getBookmarkValue(child.props.bookmark);
      const ref = refs++;
      const newHierarchy = {
        ref,
        parent: (_parent = parent) === null || _parent === void 0 ? void 0 : _parent.ref,
        ...bookmark
      };
      child.props.bookmark = newHierarchy;
      parent = newHierarchy;
    }
    if (child.children) {
      child.children.forEach(childNode => {
        listToExplore.push({
          value: childNode,
          parent
        });
      });
    }
  }
  return node;
};

const VALID_ORIENTATIONS = ['portrait', 'landscape'];

/**
 * Get page orientation. Defaults to portrait
 *
 * @param {Object} page object
 * @returns {string} page orientation
 */
const getOrientation = page => {
  var _page$props;
  const value = ((_page$props = page.props) === null || _page$props === void 0 ? void 0 : _page$props.orientation) || 'portrait';
  return VALID_ORIENTATIONS.includes(value) ? value : 'portrait';
};

/**
 * Return true if page is landscape
 *
 * @param {Object} page instance
 * @returns {boolean} is page landscape
 */
const isLandscape = page => getOrientation(page) === 'landscape';

const PAGE_SIZES = {
  '4A0': [4767.87, 6740.79],
  '2A0': [3370.39, 4767.87],
  A0: [2383.94, 3370.39],
  A1: [1683.78, 2383.94],
  A2: [1190.55, 1683.78],
  A3: [841.89, 1190.55],
  A4: [595.28, 841.89],
  A5: [419.53, 595.28],
  A6: [297.64, 419.53],
  A7: [209.76, 297.64],
  A8: [147.4, 209.76],
  A9: [104.88, 147.4],
  A10: [73.7, 104.88],
  B0: [2834.65, 4008.19],
  B1: [2004.09, 2834.65],
  B2: [1417.32, 2004.09],
  B3: [1000.63, 1417.32],
  B4: [708.66, 1000.63],
  B5: [498.9, 708.66],
  B6: [354.33, 498.9],
  B7: [249.45, 354.33],
  B8: [175.75, 249.45],
  B9: [124.72, 175.75],
  B10: [87.87, 124.72],
  C0: [2599.37, 3676.54],
  C1: [1836.85, 2599.37],
  C2: [1298.27, 1836.85],
  C3: [918.43, 1298.27],
  C4: [649.13, 918.43],
  C5: [459.21, 649.13],
  C6: [323.15, 459.21],
  C7: [229.61, 323.15],
  C8: [161.57, 229.61],
  C9: [113.39, 161.57],
  C10: [79.37, 113.39],
  RA0: [2437.8, 3458.27],
  RA1: [1729.13, 2437.8],
  RA2: [1218.9, 1729.13],
  RA3: [864.57, 1218.9],
  RA4: [609.45, 864.57],
  SRA0: [2551.18, 3628.35],
  SRA1: [1814.17, 2551.18],
  SRA2: [1275.59, 1814.17],
  SRA3: [907.09, 1275.59],
  SRA4: [637.8, 907.09],
  EXECUTIVE: [521.86, 756.0],
  FOLIO: [612.0, 936.0],
  LEGAL: [612.0, 1008.0],
  LETTER: [612.0, 792.0],
  TABLOID: [792.0, 1224.0],
  ID1: [153, 243]
};

/**
 * Transforms array into size object
 *
 * @param {number[]} v array
 * @returns {{ width: number, height: number }} size object with width and height
 */
const toSizeObject = v => ({
  width: v[0],
  height: v[1]
});

/**
 * Flip size object
 *
 * @param {{ width: number, height: number }} v size object
 * @returns {{ width: number, height: number }} flipped size object
 */
const flipSizeObject = v => ({
  width: v.height,
  height: v.width
});

/**
 * Adjust page size to passed DPI
 *
 * @param {{ width: number, height: number }} v size object
 * @param {number} dpi DPI
 * @returns {{ width: number, height: number }} adjusted size object
 */
const adjustDpi = (v, dpi) => ({
  width: v.width ? v.width * (72 / dpi) : v.width,
  height: v.height ? v.height * (72 / dpi) : v.height
});

/**
 * Returns size object from a given string
 *
 * @param {string} v page size string
 * @returns {{ width: number, height: number }} size object with width and height
 */
const getStringSize = v => {
  return toSizeObject(PAGE_SIZES[v.toUpperCase()]);
};

/**
 * Returns size object from a single number
 *
 * @param {number} n page size number
 * @returns {{ width: number, height: number }} size object with width and height
 */
const getNumberSize = n => toSizeObject([n]);

/**
 * Return page size in an object { width, height }
 *
 * @param {Object} page instance
 * @returns {{ width: number, height: number }} size object with width and height
 */
const getSize = page => {
  var _page$props, _page$props2;
  const value = ((_page$props = page.props) === null || _page$props === void 0 ? void 0 : _page$props.size) || 'A4';
  const dpi = parseFloat(((_page$props2 = page.props) === null || _page$props2 === void 0 ? void 0 : _page$props2.dpi) || 72);
  const type = typeof value;

  /**
   * @type {{ width: number, height: number }}
   */
  let size;
  if (type === 'string') {
    size = getStringSize(value);
  } else if (Array.isArray(value)) {
    size = toSizeObject(value);
    size = adjustDpi(size, dpi);
  } else if (type === 'number') {
    size = getNumberSize(value);
    size = adjustDpi(size, dpi);
  } else {
    size = value;
    size = adjustDpi(size, dpi);
  }
  return isLandscape(page) ? flipSizeObject(size) : size;
};

/**
 * Resolves page size
 *
 * @param {Object} page
 * @returns {Object} page with resolved size in style attribute
 */
const resolvePageSize = page => {
  const size = getSize(page);
  const style = flatten(page.style || {});
  return {
    ...page,
    style: {
      ...style,
      ...size
    }
  };
};

/**
 * Resolves page sizes
 *
 * @param {Object} root document root
 * @returns {Object} document root with resolved page sizes
 */
const resolvePageSizes = root => {
  if (!root.children) return root;
  const children = root.children.map(resolvePageSize);
  return Object.assign({}, root, {
    children
  });
};

const isFixed = node => {
  var _node$props;
  return ((_node$props = node.props) === null || _node$props === void 0 ? void 0 : _node$props.fixed) === true;
};

/**
 * Get line index at given height
 *
 * @param {Object} node
 * @param {number} height
 */
const lineIndexAtHeight = (node, height) => {
  let y = 0;
  if (!node.lines) return 0;
  for (let i = 0; i < node.lines.length; i += 1) {
    const line = node.lines[i];
    if (y + line.box.height > height) return i;
    y += line.box.height;
  }
  return node.lines.length;
};

/**
 * Get height for given text line index
 *
 * @param {Object} node
 * @param {number} index
 */
const heightAtLineIndex = (node, index) => {
  let counter = 0;
  if (!node.lines) return counter;
  for (let i = 0; i < index; i += 1) {
    const line = node.lines[i];
    if (!line) break;
    counter += line.box.height;
  }
  return counter;
};

const getLineBreak = (node, height) => {
  const top = get(node, ['box', 'top'], 0);
  const widows = get(node, ['props', 'widows'], 2);
  const orphans = get(node, ['props', 'orphans'], 2);
  const linesQuantity = node.lines.length;
  const slicedLine = lineIndexAtHeight(node, height - top);
  if (slicedLine === 0) {
    return 0;
  }
  if (linesQuantity < orphans) {
    return linesQuantity;
  }
  if (slicedLine < orphans || linesQuantity < orphans + widows) {
    return 0;
  }
  if (linesQuantity === orphans + widows) {
    return orphans;
  }
  if (linesQuantity - slicedLine < widows) {
    return linesQuantity - widows;
  }
  return slicedLine;
};

// Also receives contentArea in case it's needed
const splitText = (node, height) => {
  const slicedLineIndex = getLineBreak(node, height);
  const currentHeight = heightAtLineIndex(node, slicedLineIndex);
  const nextHeight = node.box.height - currentHeight;
  const current = Object.assign({}, node, {
    box: {
      ...node.box,
      height: currentHeight,
      borderBottomWidth: 0
    },
    style: {
      ...node.style,
      marginBottom: 0,
      paddingBottom: 0,
      borderBottomWidth: 0,
      borderBottomLeftRadius: 0,
      borderBottomRightRadius: 0
    },
    lines: node.lines.slice(0, slicedLineIndex)
  });
  const next = Object.assign({}, node, {
    box: {
      ...node.box,
      top: 0,
      height: nextHeight,
      borderTopWidth: 0
    },
    style: {
      ...node.style,
      marginTop: 0,
      paddingTop: 0,
      borderTopWidth: 0,
      borderTopLeftRadius: 0,
      borderTopRightRadius: 0
    },
    lines: node.lines.slice(slicedLineIndex)
  });
  return [current, next];
};

const getTop$1 = node => {
  var _node$box;
  return ((_node$box = node.box) === null || _node$box === void 0 ? void 0 : _node$box.top) || 0;
};
const hasFixedHeight = node => {
  var _node$style;
  return !isNil((_node$style = node.style) === null || _node$style === void 0 ? void 0 : _node$style.height);
};
const splitNode = (node, height) => {
  if (!node) return [null, null];
  const nodeTop = getTop$1(node);
  const current = Object.assign({}, node, {
    box: {
      ...node.box,
      borderBottomWidth: 0
    },
    style: {
      ...node.style,
      marginBottom: 0,
      paddingBottom: 0,
      borderBottomWidth: 0,
      borderBottomLeftRadius: 0,
      borderBottomRightRadius: 0
    }
  });
  current.style.height = height - nodeTop;
  const nextHeight = hasFixedHeight(node) ? node.box.height - (height - nodeTop) : null;
  const next = Object.assign({}, node, {
    box: {
      ...node.box,
      top: 0,
      borderTopWidth: 0
    },
    style: {
      ...node.style,
      marginTop: 0,
      paddingTop: 0,
      borderTopWidth: 0,
      borderTopLeftRadius: 0,
      borderTopRightRadius: 0
    }
  });
  if (nextHeight) {
    next.style.height = nextHeight;
  }
  return [current, next];
};

const NON_WRAP_TYPES = [P.Svg, P.Note, P.Image, P.Canvas];
const getWrap = node => {
  var _node$props;
  if (NON_WRAP_TYPES.includes(node.type)) return false;
  return isNil((_node$props = node.props) === null || _node$props === void 0 ? void 0 : _node$props.wrap) ? true : node.props.wrap;
};

const getComputedPadding = (node, edge) => {
  const {
    yogaNode
  } = node;
  return yogaNode ? yogaNode.getComputedPadding(edge) : null;
};

/**
 * Get Yoga computed paddings. Zero otherwise
 *
 * @param {Object} node
 * @returns {{ paddingTop: number, paddingRight: number, paddingBottom: number, paddingLeft: number }} paddings
 */
const getPadding = node => {
  const {
    style,
    box
  } = node;
  const paddingTop = getComputedPadding(node, Yoga.Edge.Top) || (box === null || box === void 0 ? void 0 : box.paddingTop) || (style === null || style === void 0 ? void 0 : style.paddingTop) || (style === null || style === void 0 ? void 0 : style.paddingVertical) || (style === null || style === void 0 ? void 0 : style.padding) || 0;
  const paddingRight = getComputedPadding(node, Yoga.Edge.Right) || (box === null || box === void 0 ? void 0 : box.paddingRight) || (style === null || style === void 0 ? void 0 : style.paddingRight) || (style === null || style === void 0 ? void 0 : style.paddingHorizontal) || (style === null || style === void 0 ? void 0 : style.padding) || 0;
  const paddingBottom = getComputedPadding(node, Yoga.Edge.Bottom) || (box === null || box === void 0 ? void 0 : box.paddingBottom) || (style === null || style === void 0 ? void 0 : style.paddingBottom) || (style === null || style === void 0 ? void 0 : style.paddingVertical) || (style === null || style === void 0 ? void 0 : style.padding) || 0;
  const paddingLeft = getComputedPadding(node, Yoga.Edge.Left) || (box === null || box === void 0 ? void 0 : box.paddingLeft) || (style === null || style === void 0 ? void 0 : style.paddingLeft) || (style === null || style === void 0 ? void 0 : style.paddingHorizontal) || (style === null || style === void 0 ? void 0 : style.padding) || 0;
  return {
    paddingTop,
    paddingRight,
    paddingBottom,
    paddingLeft
  };
};

const getWrapArea = page => {
  var _page$style;
  const {
    paddingBottom
  } = getPadding(page);
  const height = (_page$style = page.style) === null || _page$style === void 0 ? void 0 : _page$style.height;
  return height - paddingBottom;
};

const getContentArea = page => {
  var _page$style;
  const height = (_page$style = page.style) === null || _page$style === void 0 ? void 0 : _page$style.height;
  const {
    paddingTop,
    paddingBottom
  } = getPadding(page);
  return height - paddingBottom - paddingTop;
};

const isString = value => typeof value === 'string';
const isNumber = value => typeof value === 'number';
const isFragment = value => value && value.type === Symbol.for('react.fragment');

/**
 * Transforms a react element instance to internal element format.
 *
 * Can return multiple instances in the case of arrays or fragments.
 *
 * @param {Object} element React element
 * @returns {Object[]} parsed React elements
 */
const createInstances = element => {
  if (!element) return [];
  if (isString(element) || isNumber(element)) {
    return [{
      type: TextInstance,
      value: `${element}`
    }];
  }
  if (isFragment(element)) {
    return createInstances(element.props.children);
  }
  if (Array.isArray(element)) {
    return element.reduce((acc, el) => acc.concat(createInstances(el)), []);
  }
  if (!isString(element.type)) {
    return createInstances(element.type(element.props));
  }
  const {
    type,
    props: {
      style = {},
      children = [],
      ...props
    }
  } = element;
  const nextChildren = castArray(children).reduce((acc, child) => acc.concat(createInstances(child)), []);
  return [{
    type,
    style,
    props,
    box: {},
    children: nextChildren
  }];
};

/* eslint-disable no-continue */

const getBreak = node => {
  var _node$props;
  return ((_node$props = node.props) === null || _node$props === void 0 ? void 0 : _node$props.break) || false;
};
const getMinPresenceAhead = node => {
  var _node$props2;
  return ((_node$props2 = node.props) === null || _node$props2 === void 0 ? void 0 : _node$props2.minPresenceAhead) || 0;
};
const getFurthestEnd = elements => Math.max(...elements.map(node => node.box.top + node.box.height));
const getEndOfMinPresenceAhead = child => {
  return child.box.top + child.box.height + child.box.marginBottom + getMinPresenceAhead(child);
};
const getEndOfPresence = (child, futureElements) => {
  const afterMinPresenceAhead = getEndOfMinPresenceAhead(child);
  const endOfFurthestFutureElement = getFurthestEnd(futureElements.filter(node => {
    var _node$props3;
    return !((_node$props3 = node.props) !== null && _node$props3 !== void 0 && _node$props3.fixed);
  }));
  return Math.min(afterMinPresenceAhead, endOfFurthestFutureElement);
};
const shouldBreak = (child, futureElements, height) => {
  var _child$props;
  if ((_child$props = child.props) !== null && _child$props !== void 0 && _child$props.fixed) return false;
  const shouldSplit = height < child.box.top + child.box.height;
  const canWrap = getWrap(child);

  // Calculate the y coordinate where the desired presence of the child ends
  const endOfPresence = getEndOfPresence(child, futureElements);
  // If the child is already at the top of the page, breaking won't improve its presence
  // (as long as react-pdf does not support breaking into differently sized containers)
  const breakingImprovesPresence = child.box.top > child.box.marginTop;
  return getBreak(child) || shouldSplit && !canWrap || !shouldSplit && endOfPresence > height && breakingImprovesPresence;
};

const IGNORABLE_CODEPOINTS = [8232,
// LINE_SEPARATOR
8233 // PARAGRAPH_SEPARATOR
];
const buildSubsetForFont = font => IGNORABLE_CODEPOINTS.reduce((acc, codePoint) => {
  if (font && font.hasGlyphForCodePoint && font.hasGlyphForCodePoint(codePoint)) {
    return acc;
  }
  return [...acc, String.fromCharCode(codePoint)];
}, []);
const ignoreChars = fragments => fragments.map(fragment => {
  const charSubset = buildSubsetForFont(fragment.attributes.font);
  const subsetRegex = new RegExp(charSubset.join('|'));
  return {
    string: fragment.string.replace(subsetRegex, ''),
    attributes: fragment.attributes
  };
});

const PREPROCESSORS = [ignoreChars, embedEmojis];
const isImage$1 = node => node.type === P.Image;
const isTextInstance$2 = node => node.type === P.TextInstance;

/**
 * Get textkit fragments of given node object
 *
 * @param {Object} fontStore font store
 * @param {Object} instance node
 * @param {string} [parentLink] parent link
 * @param {number} [level] fragment level
 * @returns {Object[]} text fragments
 */
const getFragments = function (fontStore, instance, parentLink, level) {
  var _instance$props, _instance$props2;
  if (level === void 0) {
    level = 0;
  }
  if (!instance) return [{
    string: ''
  }];
  let fragments = [];
  const {
    color = 'black',
    direction = 'ltr',
    fontFamily = 'Helvetica',
    fontWeight,
    fontStyle,
    fontSize = 18,
    textAlign,
    lineHeight,
    textDecoration,
    textDecorationColor,
    textDecorationStyle,
    textTransform,
    letterSpacing,
    textIndent,
    opacity,
    verticalAlign
  } = instance.style;
  const fontFamilies = typeof fontFamily === 'string' ? [fontFamily] : [...(fontFamily || [])];
  const font = fontFamilies.map(fontFamilyName => {
    if (typeof fontFamilyName !== 'string') return fontFamilyName;
    const opts = {
      fontFamily: fontFamilyName,
      fontWeight,
      fontStyle
    };
    const obj = fontStore ? fontStore.getFont(opts) : null;
    return obj ? obj.data : fontFamilyName;
  });

  // Don't pass main background color to textkit. Will be rendered by the render package instead
  const backgroundColor = level === 0 ? null : instance.style.backgroundColor;
  const attributes = {
    font,
    color,
    opacity,
    fontSize,
    direction,
    verticalAlign,
    backgroundColor,
    indent: textIndent,
    characterSpacing: letterSpacing,
    strikeStyle: textDecorationStyle,
    underlineStyle: textDecorationStyle,
    underline: textDecoration === 'underline' || textDecoration === 'underline line-through' || textDecoration === 'line-through underline',
    strike: textDecoration === 'line-through' || textDecoration === 'underline line-through' || textDecoration === 'line-through underline',
    strikeColor: textDecorationColor || color,
    underlineColor: textDecorationColor || color,
    link: parentLink || ((_instance$props = instance.props) === null || _instance$props === void 0 ? void 0 : _instance$props.src) || ((_instance$props2 = instance.props) === null || _instance$props2 === void 0 ? void 0 : _instance$props2.href),
    lineHeight: lineHeight ? lineHeight * fontSize : null,
    align: textAlign || (direction === 'rtl' ? 'right' : 'left')
  };
  for (let i = 0; i < instance.children.length; i += 1) {
    const child = instance.children[i];
    if (isImage$1(child)) {
      fragments.push({
        string: String.fromCharCode(0xfffc),
        attributes: {
          ...attributes,
          attachment: {
            width: child.style.width || fontSize,
            height: child.style.height || fontSize,
            image: child.image.data
          }
        }
      });
    } else if (isTextInstance$2(child)) {
      fragments.push({
        string: transformText(child.value, textTransform),
        attributes
      });
    } else if (child) {
      fragments.push(...getFragments(fontStore, child, attributes.link, level + 1));
    }
  }
  for (let i = 0; i < PREPROCESSORS.length; i += 1) {
    const preprocessor = PREPROCESSORS[i];
    fragments = preprocessor(fragments);
  }
  return fragments;
};

/**
 * Get textkit attributed string from text node
 *
 * @param {Object} fontStore font store
 * @param {Object} instance node
 * @returns {Object} attributed string
 */
const getAttributedString = (fontStore, instance) => {
  const fragments = getFragments(fontStore, instance);
  return fromFragments(fragments);
};

const engines = {
  bidi,
  linebreaker,
  justification,
  textDecoration,
  scriptItemizer,
  wordHyphenation,
  fontSubstitution
};
const engine = layoutEngine(engines);
const getMaxLines = node => {
  var _node$style;
  return (_node$style = node.style) === null || _node$style === void 0 ? void 0 : _node$style.maxLines;
};
const getTextOverflow = node => {
  var _node$style2;
  return (_node$style2 = node.style) === null || _node$style2 === void 0 ? void 0 : _node$style2.textOverflow;
};

/**
 * Get layout container for specific text node
 *
 * @param {number} width
 * @param {number} height
 * @param {Object} node
 * @returns {Object} layout container
 */
const getContainer = (width, height, node) => {
  const maxLines = getMaxLines(node);
  const textOverflow = getTextOverflow(node);
  return {
    x: 0,
    y: 0,
    width,
    maxLines,
    height: height || Infinity,
    truncateMode: textOverflow
  };
};

/**
 * Get text layout options for specific text node
 *
 * @param {Object} node instance
 * @returns {Object} layout options
 */
const getLayoutOptions = (fontStore, node) => ({
  hyphenationPenalty: node.props.hyphenationPenalty,
  shrinkWhitespaceFactor: {
    before: -0.5,
    after: -0.5
  },
  hyphenationCallback: node.props.hyphenationCallback || (fontStore === null || fontStore === void 0 ? void 0 : fontStore.getHyphenationCallback()) || null
});

/**
 * Get text lines for given node
 *
 * @param {Object} node node
 * @param {number} width container width
 * @param {number} height container height
 * @param {number} fontStore font store
 * @returns {Object[]} layout lines
 */
const layoutText = (node, width, height, fontStore) => {
  const attributedString = getAttributedString(fontStore, node);
  const container = getContainer(width, height, node);
  const options = getLayoutOptions(fontStore, node);
  const lines = engine(attributedString, container, options);
  return lines.reduce((acc, line) => [...acc, ...line], []);
};

const isType$2 = type => node => node.type === type;
const isSvg$2 = isType$2(P.Svg);
const isText$4 = isType$2(P.Text);
const shouldIterate = node => !isSvg$2(node) && !isText$4(node);
const shouldLayoutText = node => isText$4(node) && !node.lines;

/**
 * Performs text layout on text node if wasn't calculated before.
 * Text layout is usually performed on Yoga's layout process (via setMeasureFunc),
 * but we need to layout those nodes with fixed width and height.
 *
 * @param {Object} node
 * @returns {Object} layout node
 */
const resolveTextLayout = (node, fontStore) => {
  if (shouldLayoutText(node)) {
    const width = node.box.width - (node.box.paddingRight + node.box.paddingLeft);
    const height = node.box.height - (node.box.paddingTop + node.box.paddingBottom);

    // eslint-disable-next-line no-param-reassign
    node.lines = layoutText(node, width, height, fontStore);
  }
  if (shouldIterate(node)) {
    if (!node.children) return node;
    const mapChild = child => resolveTextLayout(child, fontStore);
    const children = node.children.map(mapChild);
    return Object.assign({}, node, {
      children
    });
  }
  return node;
};

const BASE_INHERITABLE_PROPERTIES = ['color', 'fontFamily', 'fontSize', 'fontStyle', 'fontWeight', 'letterSpacing', 'opacity', 'textDecoration', 'textTransform', 'lineHeight', 'textAlign', 'visibility', 'wordSpacing'];
const TEXT_INHERITABLE_PROPERTIES = [...BASE_INHERITABLE_PROPERTIES, 'backgroundColor'];
const isSvg$1 = node => node.type === P.Svg;
const isText$3 = node => node.type === P.Text;

// Merge style values
const mergeValues = (styleName, value, inheritedValue) => {
  switch (styleName) {
    case 'textDecoration':
      {
        // merge not none and not false textDecoration values to one rule
        return [inheritedValue, value].filter(v => v && v !== 'none').join(' ');
      }
    default:
      return value;
  }
};

// Merge inherited and node styles
const merge = (inheritedStyles, style) => {
  const mergedStyles = {
    ...inheritedStyles
  };
  Object.entries(style).forEach(_ref => {
    let [styleName, value] = _ref;
    mergedStyles[styleName] = mergeValues(styleName, value, inheritedStyles[styleName]);
  });
  return mergedStyles;
};

/**
 * @typedef {Function} MergeStyles
 * @param {Object} node
 * @returns {Object} node with styles merged
 */

/**
 * Merges styles with node
 *
 * @param {Object} inheritedStyles style object
 * @returns {MergeStyles} merge styles function
 */
const mergeStyles = inheritedStyles => node => {
  const style = merge(inheritedStyles, node.style || {});
  return Object.assign({}, node, {
    style
  });
};

/**
 * Inherit style values from the root to the leafs
 *
 * @param {Object} node document root
 * @returns {Object} document root with inheritance
 *
 */
const resolveInheritance = node => {
  if (isSvg$1(node)) return node;
  if (!node.children) return node;
  const inheritableProperties = isText$3(node) ? TEXT_INHERITABLE_PROPERTIES : BASE_INHERITABLE_PROPERTIES;
  const inheritStyles = pick(inheritableProperties, node.style || {});
  const resolveChild = compose(resolveInheritance, mergeStyles(inheritStyles));
  const children = node.children.map(resolveChild);
  return Object.assign({}, node, {
    children
  });
};

const getComputedMargin = (node, edge) => {
  const {
    yogaNode
  } = node;
  return yogaNode ? yogaNode.getComputedMargin(edge) : null;
};

/**
 * Get Yoga computed magins. Zero otherwise
 *
 * @param {Object} node
 * @returns {{ marginTop: number, marginRight: number, marginBottom: number, marginLeft: number }} margins
 */
const getMargin = node => {
  const {
    style,
    box
  } = node;
  const marginTop = getComputedMargin(node, Yoga.Edge.Top) || (box === null || box === void 0 ? void 0 : box.marginTop) || (style === null || style === void 0 ? void 0 : style.marginTop) || (style === null || style === void 0 ? void 0 : style.marginVertical) || (style === null || style === void 0 ? void 0 : style.margin) || 0;
  const marginRight = getComputedMargin(node, Yoga.Edge.Right) || (box === null || box === void 0 ? void 0 : box.marginRight) || (style === null || style === void 0 ? void 0 : style.marginRight) || (style === null || style === void 0 ? void 0 : style.marginHorizontal) || (style === null || style === void 0 ? void 0 : style.margin) || 0;
  const marginBottom = getComputedMargin(node, Yoga.Edge.Bottom) || (box === null || box === void 0 ? void 0 : box.marginBottom) || (style === null || style === void 0 ? void 0 : style.marginBottom) || (style === null || style === void 0 ? void 0 : style.marginVertical) || (style === null || style === void 0 ? void 0 : style.margin) || 0;
  const marginLeft = getComputedMargin(node, Yoga.Edge.Left) || (box === null || box === void 0 ? void 0 : box.marginLeft) || (style === null || style === void 0 ? void 0 : style.marginLeft) || (style === null || style === void 0 ? void 0 : style.marginHorizontal) || (style === null || style === void 0 ? void 0 : style.margin) || 0;
  return {
    marginTop,
    marginRight,
    marginBottom,
    marginLeft
  };
};

/**
 * Get Yoga computed position. Zero otherwise
 *
 * @param {Object} node
 * @returns {{ top: number, right: number, bottom: number, left: number }} position
 */
const getPosition = node => {
  const {
    yogaNode
  } = node;
  return {
    top: (yogaNode === null || yogaNode === void 0 ? void 0 : yogaNode.getComputedTop()) || 0,
    right: (yogaNode === null || yogaNode === void 0 ? void 0 : yogaNode.getComputedRight()) || 0,
    bottom: (yogaNode === null || yogaNode === void 0 ? void 0 : yogaNode.getComputedBottom()) || 0,
    left: (yogaNode === null || yogaNode === void 0 ? void 0 : yogaNode.getComputedLeft()) || 0
  };
};

const DEFAULT_DIMENSION = {
  width: 0,
  height: 0
};

/**
 * Get Yoga computed dimensions. Zero otherwise
 *
 * @param {Object} node
 * @returns {{ width: number, height: number }} dimensions
 */
const getDimension = node => {
  const {
    yogaNode
  } = node;
  if (!yogaNode) return DEFAULT_DIMENSION;
  return {
    width: yogaNode.getComputedWidth(),
    height: yogaNode.getComputedHeight()
  };
};

const getComputedBorder = (yogaNode, edge) => yogaNode ? yogaNode.getComputedBorder(edge) : 0;

/**
 * Get Yoga computed border width. Zero otherwise
 *
 * @param {Object} node
 * @returns {{ borderTopWidth: number, borderRightWidth: number, borderBottomWidth: number, borderLeftWidth: number }} border widths
 */
const getBorderWidth = node => {
  const {
    yogaNode
  } = node;
  return {
    borderTopWidth: getComputedBorder(yogaNode, Yoga.Edge.Top),
    borderRightWidth: getComputedBorder(yogaNode, Yoga.Edge.Right),
    borderBottomWidth: getComputedBorder(yogaNode, Yoga.Edge.Bottom),
    borderLeftWidth: getComputedBorder(yogaNode, Yoga.Edge.Left)
  };
};

/**
 * @typedef {Function} NodeInstanceWrapper
 * @param {Object} node node instance
 * @returns {Object} node instance
 */

/**
 * Set display attribute to node's Yoga instance
 *
 * @param {string} value display
 * @returns {NodeInstanceWrapper} node instance wrapper
 */
const setDisplay = value => node => {
  const {
    yogaNode
  } = node;
  if (yogaNode) {
    yogaNode.setDisplay(value === 'none' ? Yoga.Display.None : Yoga.Display.Flex);
  }
  return node;
};

const OVERFLOW = {
  hidden: Yoga.Overflow.Hidden,
  scroll: Yoga.Overflow.Scroll
};

/**
 * @typedef {Function} NodeInstanceWrapper
 * @param {Object} node node instance
 * @returns {Object} node instance
 */

/**
 * Set overflow attribute to node's Yoga instance
 *
 * @param {string} value overflow value
 * @returns {NodeInstanceWrapper} node instance wrapper
 */
const setOverflow = value => node => {
  const {
    yogaNode
  } = node;
  if (!isNil(value) && yogaNode) {
    const overflow = OVERFLOW[value] || Yoga.Overflow.Visible;
    yogaNode.setOverflow(overflow);
  }
  return node;
};

const FLEX_WRAP = {
  wrap: Yoga.Wrap.Wrap,
  'wrap-reverse': Yoga.Wrap.WrapReverse
};

/**
 * @typedef {Function} NodeInstanceWrapper
 * @param {Object} node node instance
 * @returns {Object} node instance
 */

/**
 * Set flex wrap attribute to node's Yoga instance
 *
 * @param {string} value flex wrap value
 * @returns {NodeInstanceWrapper} node instance wrapper
 */
const setFlexWrap = value => node => {
  const {
    yogaNode
  } = node;
  if (yogaNode) {
    const flexWrap = FLEX_WRAP[value] || Yoga.Wrap.NoWrap;
    yogaNode.setFlexWrap(flexWrap);
  }
  return node;
};

/* eslint-disable no-unused-expressions */

/**
 * @typedef {Function} NodeInstanceWrapper
 * @param {Object} node node instance
 * @returns {Object} node instance
 */

/**
 * @typedef {Function} YogaValueSetter
 * @param {any} value
 * @returns {NodeInstanceWrapper} node instance wrapper
 */

/**
 * Set generic yoga attribute to node's Yoga instance, handing `auto`, edges and percentage cases
 *
 * @param {string} attr property
 * @param {number} [edge] edge
 * @returns {YogaValueSetter} node instance wrapper
 */
const setYogaValue = (attr, edge) => value => node => {
  const {
    yogaNode
  } = node;
  if (!isNil(value) && yogaNode) {
    const hasEdge = !isNil(edge);
    const fixedMethod = `set${upperFirst(attr)}`;
    const autoMethod = `${fixedMethod}Auto`;
    const percentMethod = `${fixedMethod}Percent`;
    const percent = matchPercent(value);
    if (percent && !yogaNode[percentMethod]) {
      throw new Error(`You can't pass percentage values to ${attr} property`);
    }
    if (percent) {
      if (hasEdge) {
        var _yogaNode$percentMeth;
        (_yogaNode$percentMeth = yogaNode[percentMethod]) === null || _yogaNode$percentMeth === void 0 ? void 0 : _yogaNode$percentMeth.call(yogaNode, edge, percent.value);
      } else {
        var _yogaNode$percentMeth2;
        (_yogaNode$percentMeth2 = yogaNode[percentMethod]) === null || _yogaNode$percentMeth2 === void 0 ? void 0 : _yogaNode$percentMeth2.call(yogaNode, percent.value);
      }
    } else if (value === 'auto') {
      if (hasEdge) {
        var _yogaNode$autoMethod;
        (_yogaNode$autoMethod = yogaNode[autoMethod]) === null || _yogaNode$autoMethod === void 0 ? void 0 : _yogaNode$autoMethod.call(yogaNode, edge);
      } else {
        var _yogaNode$autoMethod2;
        (_yogaNode$autoMethod2 = yogaNode[autoMethod]) === null || _yogaNode$autoMethod2 === void 0 ? void 0 : _yogaNode$autoMethod2.call(yogaNode);
      }
    } else if (hasEdge) {
      var _yogaNode$fixedMethod;
      (_yogaNode$fixedMethod = yogaNode[fixedMethod]) === null || _yogaNode$fixedMethod === void 0 ? void 0 : _yogaNode$fixedMethod.call(yogaNode, edge, value);
    } else {
      var _yogaNode$fixedMethod2;
      (_yogaNode$fixedMethod2 = yogaNode[fixedMethod]) === null || _yogaNode$fixedMethod2 === void 0 ? void 0 : _yogaNode$fixedMethod2.call(yogaNode, value);
    }
  }
  return node;
};

/**
 * @typedef {Function} NodeInstanceWrapper
 * @param {Object} node node instance
 * @returns {Object} node instance
 */

/**
 * Set flex grow attribute to node's Yoga instance
 *
 * @param {number} value flex grow value
 * @returns {NodeInstanceWrapper} node instance wrapper
 */
const setFlexGrow = value => node => {
  return setYogaValue('flexGrow')(value || 0)(node);
};

/**
 * Set flex basis attribute to node's Yoga instance
 *
 * @param {number} flex basis value
 * @param {Object} node instance
 * @returns {Object} node instance
 */
const setFlexBasis = setYogaValue('flexBasis');

const ALIGN = {
  'flex-start': Yoga.Align.FlexStart,
  center: Yoga.Align.Center,
  'flex-end': Yoga.Align.FlexEnd,
  stretch: Yoga.Align.Stretch,
  baseline: Yoga.Align.Baseline,
  'space-between': Yoga.Align.SpaceBetween,
  'space-around': Yoga.Align.SpaceAround,
  'space-evenly': Yoga.Align.SpaceEvenly
};

/**
 * @typedef {Function} NodeInstanceWrapper
 * @param {Object} node node instance
 * @returns {Object} node instance
 */

/**
 * @typedef {Function} AlignSetter
 * @param {string} value align value
 * @returns {NodeInstanceWrapper} node instance wrapper
 */

/**
 * Set generic align attribute to node's Yoga instance
 *
 * @param {string} attr specific align property
 * @returns {AlignSetter} align setter
 */
const setAlign = attr => value => node => {
  const {
    yogaNode
  } = node;
  const defaultValue = attr === 'items' ? Yoga.Align.Stretch : Yoga.Align.Auto;
  if (yogaNode) {
    const align = ALIGN[value] || defaultValue;
    yogaNode[`setAlign${upperFirst(attr)}`](align);
  }
  return node;
};

/**
 * Set align self attribute to node's Yoga instance
 *
 * @param {string} align value
 * @param {Object} node instance
 * @returns {Object} node instance
 */
const setAlignSelf = setAlign('self');

/**
 * Set align items attribute to node's Yoga instance
 *
 * @param {string} align value
 * @param {Object} node instance
 * @returns {Object} node instance
 */
const setAlignItems = setAlign('items');

/**
 * @typedef {Function} NodeInstanceWrapper
 * @param {Object} node node instance
 * @returns {Object} node instance
 */

/**
 * Set flex shrink attribute to node's Yoga instance
 *
 * @param {number} value flex shrink value
 * @returns {NodeInstanceWrapper} node instance wrapper
 */
const setFlexShrink = value => node => {
  return setYogaValue('flexShrink')(value || 1)(node);
};

/**
 * @typedef {Function} NodeInstanceWrapper
 * @param {Object} node node instance
 * @returns {Object} node instance
 */

/**
 * Set aspect ratio attribute to node's Yoga instance
 *
 * @param {number} value ratio
 * @returns {NodeInstanceWrapper} node instance wrapper
 */
const setAspectRatio = value => node => {
  const {
    yogaNode
  } = node;
  if (!isNil(value) && yogaNode) {
    yogaNode.setAspectRatio(value);
  }
  return node;
};

/**
 * Set align content attribute to node's Yoga instance
 *
 * @param {string} align value
 * @param {Object} node instance
 * @returns {Object} node instance
 */
const setAlignContent = setAlign('content');

const POSITION = {
  absolute: Yoga.PositionType.Absolute,
  relative: Yoga.PositionType.Relative,
  static: Yoga.PositionType.Static
};

/**
 * @typedef {Function} NodeInstanceWrapper
 * @param {Object} node node instance
 * @returns {Object} node instance
 */

/**
 * Set position type attribute to node's Yoga instance
 *
 * @param {string} value position position type
 * @returns {NodeInstanceWrapper} node instance wrapper
 */
const setPositionType = value => node => {
  const {
    yogaNode
  } = node;
  if (!isNil(value) && yogaNode) {
    yogaNode.setPositionType(POSITION[value]);
  }
  return node;
};

const FLEX_DIRECTIONS = {
  row: Yoga.FlexDirection.Row,
  'row-reverse': Yoga.FlexDirection.RowReverse,
  'column-reverse': Yoga.FlexDirection.ColumnReverse
};

/**
 * @typedef {Function} NodeInstanceWrapper
 * @param {Object} node node instance
 * @returns {Object} node instance
 */

/**
 * Set flex direction attribute to node's Yoga instance
 *
 * @param {string} value flex direction value
 * @returns {NodeInstanceWrapper} node instance wrapper
 */
const setFlexDirection = value => node => {
  const {
    yogaNode
  } = node;
  if (yogaNode) {
    const flexDirection = FLEX_DIRECTIONS[value] || Yoga.FlexDirection.Column;
    yogaNode.setFlexDirection(flexDirection);
  }
  return node;
};

const JUSTIFY_CONTENT = {
  center: Yoga.Justify.Center,
  'flex-end': Yoga.Justify.FlexEnd,
  'space-between': Yoga.Justify.SpaceBetween,
  'space-around': Yoga.Justify.SpaceAround,
  'space-evenly': Yoga.Justify.SpaceEvenly
};

/**
 * @typedef {Function} NodeInstanceWrapper
 * @param {Object} node node instance
 * @returns {Object} node instance
 */

/**
 * Set justify content attribute to node's Yoga instance
 *
 * @param {string} value justify content value
 * @returns {NodeInstanceWrapper} node instance wrapper
 */
const setJustifyContent = value => node => {
  const {
    yogaNode
  } = node;
  if (!isNil(value) && yogaNode) {
    const justifyContent = JUSTIFY_CONTENT[value] || Yoga.Justify.FlexStart;
    yogaNode.setJustifyContent(justifyContent);
  }
  return node;
};

/**
 * @typedef {Function} NodeInstanceWrapper
 * @param {Object} node node instance
 * @returns {Object} node instance
 */

/**
 * Set margin top attribute to node's Yoga instance
 *
 * @param {number} margin margin top
 * @param {Object} node node instance
 * @returns {Object} node instance
 */
const setMarginTop = setYogaValue('margin', Yoga.Edge.Top);

/**
 * Set margin right attribute to node's Yoga instance
 *
 * @param {number} margin margin right
 * @param {Object} node node instance
 * @returns {Object} node instance
 */
const setMarginRight = setYogaValue('margin', Yoga.Edge.Right);

/**
 * Set margin bottom attribute to node's Yoga instance
 *
 * @param {number} margin margin bottom
 * @param {Object} node node instance
 * @returns {Object} node instance
 */
const setMarginBottom = setYogaValue('margin', Yoga.Edge.Bottom);

/**
 * Set margin left attribute to node's Yoga instance
 *
 * @param {number} margin margin left
 * @param {Object} node node instance
 * @returns {Object} node instance
 */
const setMarginLeft = setYogaValue('margin', Yoga.Edge.Left);

/**
 * @typedef {Function} NodeInstanceWrapper
 * @param {Object} node node instance
 * @returns {Object} node instance
 */

/**
 * Set padding top attribute to node's Yoga instance
 *
 * @param {number} padding padding top
 * @param {Object} node node instance
 * @returns {Object} node instance
 */
const setPaddingTop = setYogaValue('padding', Yoga.Edge.Top);

/**
 * Set padding right attribute to node's Yoga instance
 *
 * @param {number} padding padding right
 * @param {Object} node node instance
 * @returns {Object} node instance
 */
const setPaddingRight = setYogaValue('padding', Yoga.Edge.Right);

/**
 * Set padding bottom attribute to node's Yoga instance
 *
 * @param {number} padding padding bottom
 * @param {Object} node node instance
 * @returns {Object} node instance
 */
const setPaddingBottom = setYogaValue('padding', Yoga.Edge.Bottom);

/**
 * Set padding left attribute to node's Yoga instance
 *
 * @param {number} padding padding left
 * @param {Object} node node instance
 * @returns {Object} node instance
 */
const setPaddingLeft = setYogaValue('padding', Yoga.Edge.Left);

/**
 * @typedef {Function} NodeInstanceWrapper
 * @param {Object} node node instance
 * @returns {Object} node instance
 */

/**
 * Set border top attribute to node's Yoga instance
 *
 * @param {number} border border top width
 * @param {Object} node node instance
 * @returns {Object} node instance
 */
const setBorderTop = setYogaValue('border', Yoga.Edge.Top);

/**
 * Set border right attribute to node's Yoga instance
 *
 * @param {number} border border right width
 * @param {Object} node node instance
 * @returns {Object} node instance
 */
const setBorderRight = setYogaValue('border', Yoga.Edge.Right);

/**
 * Set border bottom attribute to node's Yoga instance
 *
 * @param {number} border border bottom width
 * @param {Object} node node instance
 * @returns {Object} node instance
 */
const setBorderBottom = setYogaValue('border', Yoga.Edge.Bottom);

/**
 * Set border left attribute to node's Yoga instance
 *
 * @param {number} border border left width
 * @param {Object} node node instance
 * @returns {Object} node instance
 */
const setBorderLeft = setYogaValue('border', Yoga.Edge.Left);

/**
 * @typedef {Function} NodeInstanceWrapper
 * @param {Object} node node instance
 * @returns {Object} node instance
 */

/**
 * Set position top attribute to node's Yoga instance
 *
 * @param {number} position position top
 * @param {Object} node node instance
 * @returns {Object} node instance
 */
const setPositionTop = setYogaValue('position', Yoga.Edge.Top);

/**
 * Set position right attribute to node's Yoga instance
 *
 * @param {number} position position right
 * @param {Object} node node instance
 * @returns {Object} node instance
 */
const setPositionRight = setYogaValue('position', Yoga.Edge.Right);

/**
 * Set position bottom attribute to node's Yoga instance
 *
 * @param {number} position position bottom
 * @param {Object} node node instance
 * @returns {Object} node instance
 */
const setPositionBottom = setYogaValue('position', Yoga.Edge.Bottom);

/**
 * Set position left attribute to node's Yoga instance
 *
 * @param {number} position position left
 * @param {Object} node node instance
 * @returns {Object} node instance
 */
const setPositionLeft = setYogaValue('position', Yoga.Edge.Left);

/**
 * Set width to node's Yoga instance
 *
 * @param {number} width
 * @param {Object} node instance
 * @returns {Object} node instance
 */
const setWidth = setYogaValue('width');

/**
 * Set min width to node's Yoga instance
 *
 * @param {number} min width
 * @param {Object} node instance
 * @returns {Object} node instance
 */
const setMinWidth = setYogaValue('minWidth');

/**
 * Set max width to node's Yoga instance
 *
 * @param {number} max width
 * @param {Object} node instance
 * @returns {Object} node instance
 */
const setMaxWidth = setYogaValue('maxWidth');

/**
 * Set height to node's Yoga instance
 *
 * @param {number} height
 * @param {Object} node instance
 * @returns {Object} node instance
 */
const setHeight = setYogaValue('height');

/**
 * Set min height to node's Yoga instance
 *
 * @param {number} min height
 * @param {Object} node instance
 * @returns {Object} node instance
 */
const setMinHeight = setYogaValue('minHeight');

/**
 * Set max height to node's Yoga instance
 *
 * @param {number} max height
 * @param {Object} node instance
 * @returns {Object} node instance
 */
const setMaxHeight = setYogaValue('maxHeight');

/**
 * @typedef {Function} NodeInstanceWrapper
 * @param {Object} node node instance
 * @returns {Object} node instance
 */

/**
 * Set rowGap value to node's Yoga instance
 *
 * @param {number} value gap value
 * @returns {NodeInstanceWrapper} node instance wrapper
 */
const setRowGap = value => node => {
  const {
    yogaNode
  } = node;
  if (!isNil(value) && yogaNode) {
    yogaNode.setGap(Yoga.Gutter.Row, value);
  }
  return node;
};

/**
 * Set columnGap value to node's Yoga instance
 *
 * @param {number} value gap value
 * @returns {NodeInstanceWrapper} node instance wrapper
 */
const setColumnGap = value => node => {
  const {
    yogaNode
  } = node;
  if (!isNil(value) && yogaNode) {
    yogaNode.setGap(Yoga.Gutter.Column, value);
  }
  return node;
};

const getAspectRatio = viewbox => {
  if (!viewbox) return null;
  return (viewbox.maxX - viewbox.minX) / (viewbox.maxY - viewbox.minY);
};

/**
 * @typedef {Function} MeasureSvg
 * @param {number} width
 * @param {number} widthMode
 * @param {number} height
 * @param {number} heightMode
 * @returns {{ width: number, height: number }} svg width and height
 */

/**
 * Yoga svg measure function
 *
 * @param {Object} page
 * @param {Object} node
 * @returns {MeasureSvg} measure svg
 */
const measureCanvas$1 = (page, node) => (width, widthMode, height, heightMode) => {
  const aspectRatio = getAspectRatio(node.props.viewBox) || 1;
  if (widthMode === Yoga.MeasureMode.Exactly || widthMode === Yoga.MeasureMode.AtMost) {
    return {
      width,
      height: width / aspectRatio
    };
  }
  if (heightMode === Yoga.MeasureMode.Exactly) {
    return {
      width: height * aspectRatio
    };
  }
  return {};
};

/**
 * Get lines width (if any)
 *
 * @param {Object} node
 * @returns {number} lines width
 */
const linesWidth = node => {
  if (!node.lines) return 0;
  return Math.max(0, ...node.lines.map(line => line.xAdvance));
};

/**
 * Get lines height (if any)
 *
 * @param {Object} node
 * @returns {number} lines height
 */
const linesHeight = node => {
  if (!node.lines) return -1;
  return node.lines.reduce((acc, line) => acc + line.box.height, 0);
};

/* eslint-disable no-param-reassign */

const ALIGNMENT_FACTORS = {
  center: 0.5,
  right: 1
};

/**
 * @typedef {Function} MeasureText
 * @param {number} width
 * @param {number} widthMode
 * @param {number} height
 * @returns {{ width: number, height: number }} text width and height
 */

/**
 * Yoga text measure function
 *
 * @param {Object} page
 * @param {Object} node
 * @param {Object} fontStore
 * @returns {MeasureText} measure text function
 */
const measureText = (page, node, fontStore) => (width, widthMode, height) => {
  if (widthMode === Yoga.MeasureMode.Exactly) {
    if (!node.lines) node.lines = layoutText(node, width, height, fontStore);
    return {
      height: linesHeight(node)
    };
  }
  if (widthMode === Yoga.MeasureMode.AtMost) {
    var _node$style;
    const alignFactor = ALIGNMENT_FACTORS[(_node$style = node.style) === null || _node$style === void 0 ? void 0 : _node$style.textAlign] || 0;
    if (!node.lines) {
      node.lines = layoutText(node, width, height, fontStore);
      node.alignOffset = (width - linesWidth(node)) * alignFactor; // Compensate align in variable width containers
    }
    return {
      height: linesHeight(node),
      width: Math.min(width, linesWidth(node))
    };
  }
  return {};
};

/**
 * Get image ratio
 *
 * @param {Object} node image node
 * @returns {number} image ratio
 */
const getRatio = node => {
  var _node$image;
  return (_node$image = node.image) !== null && _node$image !== void 0 && _node$image.data ? node.image.width / node.image.height : 1;
};

/**
 * Checks if page has auto height
 *
 * @param {Object} page
 * @returns {boolean} is page height auto
 */
const isHeightAuto = page => {
  var _page$box;
  return isNil((_page$box = page.box) === null || _page$box === void 0 ? void 0 : _page$box.height);
};

const SAFETY_HEIGHT$1 = 10;

/**
 * @typedef {Function} MeasureImage
 * @param {number} width
 * @param {number} widthMode
 * @param {number} height
 * @param {number} heightMode
 * @returns {{ width: number, height: number }} image width and height
 */

/**
 * Yoga image measure function
 *
 * @param {Object} page page
 * @param {Object} node node
 * @returns {MeasureImage} measure image
 */
const measureImage = (page, node) => (width, widthMode, height, heightMode) => {
  const imageRatio = getRatio(node);
  const imageMargin = getMargin(node);
  const pagePadding = getPadding(page);
  const pageArea = isHeightAuto(page) ? Infinity : page.box.height - pagePadding.paddingTop - pagePadding.paddingBottom - imageMargin.marginTop - imageMargin.marginBottom - SAFETY_HEIGHT$1;

  // Skip measure if image data not present yet
  if (!node.image) return {
    width: 0,
    height: 0
  };
  if (widthMode === Yoga.MeasureMode.Exactly && heightMode === Yoga.MeasureMode.Undefined) {
    const scaledHeight = width / imageRatio;
    return {
      height: Math.min(pageArea, scaledHeight)
    };
  }
  if (heightMode === Yoga.MeasureMode.Exactly && (widthMode === Yoga.MeasureMode.AtMost || widthMode === Yoga.MeasureMode.Undefined)) {
    return {
      width: Math.min(height * imageRatio, width)
    };
  }
  if (widthMode === Yoga.MeasureMode.Exactly && heightMode === Yoga.MeasureMode.AtMost) {
    const scaledHeight = width / imageRatio;
    return {
      height: Math.min(height, pageArea, scaledHeight)
    };
  }
  if (widthMode === Yoga.MeasureMode.AtMost && heightMode === Yoga.MeasureMode.AtMost) {
    if (imageRatio > 1) {
      return {
        width,
        height: Math.min(width / imageRatio, height)
      };
    }
    return {
      height,
      width: Math.min(height * imageRatio, width)
    };
  }
  return {
    height,
    width
  };
};

/* eslint-disable no-param-reassign */

const SAFETY_HEIGHT = 10;
const getMax = values => Math.max(-Infinity, ...values);

/**
 * Helper object to predict canvas size
 * TODO: Implement remaining functions (as close as possible);
 */
const measureCtx = () => {
  const ctx = {};
  const points = [];
  const nil = () => ctx;
  const addPoint = (x, y) => points.push([x, y]);
  const moveTo = function () {
    addPoint(...arguments);
    return ctx;
  };
  const rect = (x, y, w, h) => {
    addPoint(x, y);
    addPoint(x + w, y);
    addPoint(x, y + h);
    addPoint(x + w, y + h);
    return ctx;
  };
  const ellipse = (x, y, rx, ry) => {
    ry = ry || rx;
    addPoint(x - rx, y - ry);
    addPoint(x + rx, y - ry);
    addPoint(x + rx, y + ry);
    addPoint(x - rx, y + ry);
    return ctx;
  };
  const polygon = function () {
    points.push(...arguments);
    return ctx;
  };

  // Change dimensions
  ctx.rect = rect;
  ctx.moveTo = moveTo;
  ctx.lineTo = moveTo;
  ctx.circle = ellipse;
  ctx.polygon = polygon;
  ctx.ellipse = ellipse;
  ctx.roundedRect = rect;

  // To be implemented
  ctx.text = nil;
  ctx.path = nil;
  ctx.lineWidth = nil;
  ctx.bezierCurveTo = nil;
  ctx.quadraticCurveTo = nil;
  ctx.scale = nil;
  ctx.rotate = nil;
  ctx.translate = nil;

  // These don't change dimensions
  ctx.dash = nil;
  ctx.clip = nil;
  ctx.save = nil;
  ctx.fill = nil;
  ctx.font = nil;
  ctx.stroke = nil;
  ctx.lineCap = nil;
  ctx.opacity = nil;
  ctx.restore = nil;
  ctx.lineJoin = nil;
  ctx.fontSize = nil;
  ctx.fillColor = nil;
  ctx.miterLimit = nil;
  ctx.strokeColor = nil;
  ctx.fillOpacity = nil;
  ctx.strokeOpacity = nil;
  ctx.linearGradient = nil;
  ctx.radialGradient = nil;
  ctx.getWidth = () => getMax(points.map(p => p[0]));
  ctx.getHeight = () => getMax(points.map(p => p[1]));
  return ctx;
};

/**
 * @typedef {Function} MeasureCanvas
 * @returns {{ width: number, height: number }} canvas width and height
 */

/**
 * Yoga canvas measure function
 *
 * @param {Object} page
 * @param {Object} node
 * @returns {MeasureCanvas} measure canvas
 */
const measureCanvas = (page, node) => () => {
  const imageMargin = getMargin(node);
  const pagePadding = getPadding(page);
  const pageArea = isHeightAuto(page) ? Infinity : page.box.height - pagePadding.paddingTop - pagePadding.paddingBottom - imageMargin.marginTop - imageMargin.marginBottom - SAFETY_HEIGHT;
  const ctx = measureCtx();
  node.props.paint(ctx);
  const width = ctx.getWidth();
  const height = Math.min(pageArea, ctx.getHeight());
  return {
    width,
    height
  };
};

const isType$1 = type => node => node.type === type;
const isSvg = isType$1(P.Svg);
const isText$2 = isType$1(P.Text);
const isNote = isType$1(P.Note);
const isPage = isType$1(P.Page);
const isImage = isType$1(P.Image);
const isCanvas = isType$1(P.Canvas);
const isTextInstance$1 = isType$1(P.TextInstance);
const setNodeHeight = node => {
  const value = isPage(node) ? node.box.height : node.style.height;
  return setHeight(value);
};

/**
 * Set styles valeus into yoga node before layout calculation
 *
 * @param {Object} node
 * @returns {Object} node
 */
const setYogaValues = node => {
  compose(setNodeHeight(node), setWidth(node.style.width), setMinWidth(node.style.minWidth), setMaxWidth(node.style.maxWidth), setMinHeight(node.style.minHeight), setMaxHeight(node.style.maxHeight), setMarginTop(node.style.marginTop), setMarginRight(node.style.marginRight), setMarginBottom(node.style.marginBottom), setMarginLeft(node.style.marginLeft), setPaddingTop(node.style.paddingTop), setPaddingRight(node.style.paddingRight), setPaddingBottom(node.style.paddingBottom), setPaddingLeft(node.style.paddingLeft), setPositionType(node.style.position), setPositionTop(node.style.top), setPositionRight(node.style.right), setPositionBottom(node.style.bottom), setPositionLeft(node.style.left), setBorderTop(node.style.borderTopWidth), setBorderRight(node.style.borderRightWidth), setBorderBottom(node.style.borderBottomWidth), setBorderLeft(node.style.borderLeftWidth), setDisplay(node.style.display), setFlexDirection(node.style.flexDirection), setAlignSelf(node.style.alignSelf), setAlignContent(node.style.alignContent), setAlignItems(node.style.alignItems), setJustifyContent(node.style.justifyContent), setFlexWrap(node.style.flexWrap), setOverflow(node.style.overflow), setAspectRatio(node.style.aspectRatio), setFlexBasis(node.style.flexBasis), setFlexGrow(node.style.flexGrow), setFlexShrink(node.style.flexShrink), setRowGap(node.style.rowGap), setColumnGap(node.style.columnGap))(node);
};

/**
 * @typedef {Function} InsertYogaNodes
 * @param {Object} child child node
 * @returns {Object} node
 */

/**
 * Inserts child into parent' yoga node
 *
 * @param {Object} parent parent
 * @returns {InsertYogaNodes} insert yoga nodes
 */
const insertYogaNodes = parent => child => {
  parent.insertChild(child.yogaNode, parent.getChildCount());
  return child;
};
const setMeasureFunc = (node, page, fontStore) => {
  const {
    yogaNode
  } = node;
  if (isText$2(node)) {
    yogaNode.setMeasureFunc(measureText(page, node, fontStore));
  }
  if (isImage(node)) {
    yogaNode.setMeasureFunc(measureImage(page, node));
  }
  if (isCanvas(node)) {
    yogaNode.setMeasureFunc(measureCanvas(page, node));
  }
  if (isSvg(node)) {
    yogaNode.setMeasureFunc(measureCanvas$1(page, node));
  }
  return node;
};
const isLayoutElement = node => !isText$2(node) && !isNote(node) && !isSvg(node);

/**
 * @typedef {Function} CreateYogaNodes
 * @param {Object} node
 * @returns {Object} node with appended yoga node
 */

/**
 * Creates and add yoga node to document tree
 * Handles measure function for text and image nodes
 *
 * @returns {CreateYogaNodes} create yoga nodes
 */
const createYogaNodes = (page, fontStore, yoga) => node => {
  const yogaNode = yoga.node.create();
  const result = Object.assign({}, node, {
    yogaNode
  });
  setYogaValues(result);
  if (isLayoutElement(node) && node.children) {
    const resolveChild = compose(insertYogaNodes(yogaNode), createYogaNodes(page, fontStore, yoga));
    result.children = node.children.map(resolveChild);
  }
  setMeasureFunc(result, page, fontStore);
  return result;
};

/**
 * Performs yoga calculation
 *
 * @param {Object} page page node
 * @returns {Object} page node
 */
const calculateLayout = page => {
  page.yogaNode.calculateLayout();
  return page;
};

/**
 * Saves Yoga layout result into 'box' attribute of node
 *
 * @param {Object} node
 * @returns {Object} node with box data
 */
const persistDimensions = node => {
  if (isTextInstance$1(node)) return node;
  const box = Object.assign(getPadding(node), getMargin(node), getBorderWidth(node), getPosition(node), getDimension(node));
  const newNode = Object.assign({}, node, {
    box
  });
  if (!node.children) return newNode;
  const children = node.children.map(persistDimensions);
  return Object.assign({}, newNode, {
    children
  });
};

/**
 * Removes yoga node from document tree
 *
 * @param {Object} node
 * @returns {Object} node without yoga node
 */
const destroyYogaNodes = node => {
  const newNode = Object.assign({}, node);
  delete newNode.yogaNode;
  if (!node.children) return newNode;
  const children = node.children.map(destroyYogaNodes);
  return Object.assign({}, newNode, {
    children
  });
};

/**
 * Free yoga node from document tree
 *
 * @param {Object} node
 * @returns {Object} node without yoga node
 */
const freeYogaNodes = node => {
  if (node.yogaNode) node.yogaNode.freeRecursive();
  return node;
};

/**
 * Calculates page object layout using Yoga.
 * Takes node values from 'box' and 'style' attributes, and persist them back into 'box'
 * Destroy yoga values at the end.
 *
 * @param {Object} page object
 * @returns {Object} page object with correct 'box' layout attributes
 */
const resolvePageDimensions = (page, fontStore, yoga) => {
  if (isNil(page)) return null;
  return compose(destroyYogaNodes, freeYogaNodes, persistDimensions, calculateLayout, createYogaNodes(page, fontStore, yoga))(page);
};

/**
 * Calculates root object layout using Yoga.
 *
 * @param {Object} node root object
 * @param {Object} fontStore font store
 * @returns {Object} root object with correct 'box' layout attributes
 */
const resolveDimensions = (node, fontStore) => {
  if (!node.children) return node;
  const resolveChild = child => resolvePageDimensions(child, fontStore, node.yoga);
  const children = node.children.map(resolveChild);
  return Object.assign({}, node, {
    children
  });
};

/* eslint-disable no-use-before-define */
/* eslint-disable no-continue */
/* eslint-disable prefer-destructuring */

const isText$1 = node => node.type === P.Text;

// Prevent splitting elements by low decimal numbers
const SAFETY_THRESHOLD = 0.001;
const assingChildren = (children, node) => Object.assign({}, node, {
  children
});
const getTop = node => {
  var _node$box;
  return ((_node$box = node.box) === null || _node$box === void 0 ? void 0 : _node$box.top) || 0;
};
const allFixed = nodes => nodes.every(isFixed);
const isDynamic = node => {
  var _node$props;
  return !isNil((_node$props = node.props) === null || _node$props === void 0 ? void 0 : _node$props.render);
};
const relayoutPage = compose(resolveTextLayout, resolvePageDimensions, resolveInheritance, resolvePageStyles);
const warnUnavailableSpace = node => {
  console.warn(`Node of type ${node.type} can't wrap between pages and it's bigger than available page height`);
};
const splitNodes = (height, contentArea, nodes) => {
  const currentChildren = [];
  const nextChildren = [];
  for (let i = 0; i < nodes.length; i += 1) {
    const child = nodes[i];
    const futureNodes = nodes.slice(i + 1);
    const futureFixedNodes = futureNodes.filter(isFixed);
    const nodeTop = getTop(child);
    const nodeHeight = child.box.height;
    const isOutside = height <= nodeTop;
    const shouldBreak$1 = shouldBreak(child, futureNodes, height);
    const shouldSplit = height + SAFETY_THRESHOLD < nodeTop + nodeHeight;
    const canWrap = getWrap(child);
    const fitsInsidePage = nodeHeight <= contentArea;
    if (isFixed(child)) {
      nextChildren.push(child);
      currentChildren.push(child);
      continue;
    }
    if (isOutside) {
      const box = Object.assign({}, child.box, {
        top: child.box.top - height
      });
      const next = Object.assign({}, child, {
        box
      });
      nextChildren.push(next);
      continue;
    }
    if (!fitsInsidePage && !canWrap) {
      currentChildren.push(child);
      nextChildren.push(...futureNodes);
      warnUnavailableSpace(child);
      break;
    }
    if (shouldBreak$1) {
      const box = Object.assign({}, child.box, {
        top: child.box.top - height
      });
      const props = Object.assign({}, child.props, {
        wrap: true,
        break: false
      });
      const next = Object.assign({}, child, {
        box,
        props
      });
      currentChildren.push(...futureFixedNodes);
      nextChildren.push(next, ...futureNodes);
      break;
    }
    if (shouldSplit) {
      const [currentChild, nextChild] = split(child, height, contentArea);

      // All children are moved to the next page, it doesn't make sense to show the parent on the current page
      if (child.children.length > 0 && currentChild.children.length === 0) {
        // But if the current page is empty then we can just include the parent on the current page
        if (currentChildren.length === 0) {
          currentChildren.push(child, ...futureFixedNodes);
          nextChildren.push(...futureNodes);
        } else {
          const box = Object.assign({}, child.box, {
            top: child.box.top - height
          });
          const next = Object.assign({}, child, {
            box
          });
          currentChildren.push(...futureFixedNodes);
          nextChildren.push(next, ...futureNodes);
        }
        break;
      }
      if (currentChild) currentChildren.push(currentChild);
      if (nextChild) nextChildren.push(nextChild);
      continue;
    }
    currentChildren.push(child);
  }
  return [currentChildren, nextChildren];
};
const splitChildren = (height, contentArea, node) => {
  const children = node.children || [];
  const availableHeight = height - getTop(node);
  return splitNodes(availableHeight, contentArea, children);
};
const splitView = (node, height, contentArea) => {
  const [currentNode, nextNode] = splitNode(node, height);
  const [currentChilds, nextChildren] = splitChildren(height, contentArea, node);
  return [assingChildren(currentChilds, currentNode), assingChildren(nextChildren, nextNode)];
};
const split = (node, height, contentArea) => isText$1(node) ? splitText(node, height) : splitView(node, height, contentArea);
const shouldResolveDynamicNodes = node => {
  const children = node.children || [];
  return isDynamic(node) || children.some(shouldResolveDynamicNodes);
};
const resolveDynamicNodes = (props, node) => {
  const isNodeDynamic = isDynamic(node);

  // Call render prop on dynamic nodes and append result to children
  const resolveChildren = function (children) {
    if (children === void 0) {
      children = [];
    }
    if (isNodeDynamic) {
      const res = node.props.render(props);
      return createInstances(res).filter(Boolean).map(n => resolveDynamicNodes(props, n));
    }
    return children.map(c => resolveDynamicNodes(props, c));
  };

  // We reset dynamic text box so it can be computed again later on
  const resetHeight = isNodeDynamic && isText$1(node);
  const box = resetHeight ? {
    ...node.box,
    height: 0
  } : node.box;
  const children = resolveChildren(node.children);
  const lines = isNodeDynamic ? null : node.lines;
  return Object.assign({}, node, {
    box,
    lines,
    children
  });
};
const resolveDynamicPage = (props, page, fontStore, yoga) => {
  if (shouldResolveDynamicNodes(page)) {
    const resolvedPage = resolveDynamicNodes(props, page);
    return relayoutPage(resolvedPage, fontStore, yoga);
  }
  return page;
};
const splitPage = (page, pageNumber, fontStore, yoga) => {
  const wrapArea = getWrapArea(page);
  const contentArea = getContentArea(page);
  const dynamicPage = resolveDynamicPage({
    pageNumber
  }, page, fontStore, yoga);
  const height = page.style.height;
  const [currentChilds, nextChilds] = splitNodes(wrapArea, contentArea, dynamicPage.children);
  const relayout = node => relayoutPage(node, fontStore, yoga);
  const currentBox = {
    ...page.box,
    height
  };
  const currentPage = relayout(Object.assign({}, page, {
    box: currentBox,
    children: currentChilds
  }));
  if (nextChilds.length === 0 || allFixed(nextChilds)) return [currentPage, null];
  const nextBox = omit('height', page.box);
  const nextProps = omit('bookmark', page.props);
  const nextPage = relayout(Object.assign({}, page, {
    props: nextProps,
    box: nextBox,
    children: nextChilds
  }));
  return [currentPage, nextPage];
};
const resolvePageIndices = (fontStore, yoga, page, pageNumber, pages) => {
  const totalPages = pages.length;
  const props = {
    totalPages,
    pageNumber: pageNumber + 1,
    subPageNumber: page.subPageNumber + 1,
    subPageTotalPages: page.subPageTotalPages
  };
  return resolveDynamicPage(props, page, fontStore, yoga);
};
const assocSubPageData = subpages => {
  return subpages.map((page, i) => ({
    ...page,
    subPageNumber: i,
    subPageTotalPages: subpages.length
  }));
};
const dissocSubPageData = page => {
  return omit(['subPageNumber', 'subPageTotalPages'], page);
};
const paginate = (page, pageNumber, fontStore, yoga) => {
  var _page$props;
  if (!page) return [];
  if (((_page$props = page.props) === null || _page$props === void 0 ? void 0 : _page$props.wrap) === false) return [page];
  let splittedPage = splitPage(page, pageNumber, fontStore, yoga);
  const pages = [splittedPage[0]];
  let nextPage = splittedPage[1];
  while (nextPage !== null) {
    splittedPage = splitPage(nextPage, pageNumber + pages.length, fontStore, yoga);
    pages.push(splittedPage[0]);
    nextPage = splittedPage[1];
  }
  return pages;
};

/**
 * Performs pagination. This is the step responsible of breaking the whole document
 * into pages following pagiation rules, such as `fixed`, `break` and dynamic nodes.
 *
 * @param {Object} doc node
 * @param {Object} fontStore font store
 * @returns {Object} layout node
 */
const resolvePagination = (doc, fontStore) => {
  let pages = [];
  let pageNumber = 1;
  for (let i = 0; i < doc.children.length; i += 1) {
    const page = doc.children[i];
    let subpages = paginate(page, pageNumber, fontStore, doc.yoga);
    subpages = assocSubPageData(subpages);
    pageNumber += subpages.length;
    pages = pages.concat(subpages);
  }
  pages = pages.map(function () {
    for (var _len = arguments.length, args = new Array(_len), _key = 0; _key < _len; _key++) {
      args[_key] = arguments[_key];
    }
    return dissocSubPageData(resolvePageIndices(fontStore, doc.yoga, ...args));
  });
  return assingChildren(pages, doc);
};

/**
 * @typedef {Function} ResolvePageHorizontalPadding
 * @param {string} value padding value
 * @returns {Object} translated padding value
 */

/**
 * Translates page percentage horizontal paddings in fixed ones
 *
 * @param {Object} container page container
 * @returns {ResolvePageHorizontalPadding} resolve page horizontal padding
 */
const resolvePageHorizontalPadding = container => value => {
  const match = matchPercent(value);
  return match ? match.percent * container.width : value;
};

/**
 * @typedef {Function} ResolvePageVerticalPadding
 * @param {string} padding value
 * @returns {Object} translated padding value
 */

/**
 * Translates page percentage vertical paddings in fixed ones
 *
 * @param {Object} container page container
 * @returns {ResolvePageVerticalPadding} resolve page vertical padding
 */
const resolvePageVerticalPadding = container => value => {
  const match = matchPercent(value);
  return match ? match.percent * container.height : value;
};

/**
 * Translates page percentage paddings in fixed ones
 *
 * @param {Object} page
 * @returns {Object} page with fixed paddings
 */
const resolvePagePaddings = page => {
  const container = page.style;
  const style = evolve({
    paddingTop: resolvePageVerticalPadding(container),
    paddingLeft: resolvePageHorizontalPadding(container),
    paddingRight: resolvePageHorizontalPadding(container),
    paddingBottom: resolvePageVerticalPadding(container)
  }, page.style);
  return Object.assign({}, page, {
    style
  });
};

/**
 * Translates all pages percentage paddings in fixed ones
 * This has to be computed from pages calculated size and not by Yoga
 * because at this point we didn't performed pagination yet.
 *
 * @param {Object} root document root
 * @returns {Object} document root with translated page paddings
 */
const resolvePagesPaddings = root => {
  if (!root.children) return root;
  const children = root.children.map(resolvePagePaddings);
  return Object.assign({}, root, {
    children
  });
};

/**
 * @typedef {Function} ResolveRadius
 * @param {string | number} value border radius value
 * @returns {number} resolved radius value
 */

/**
 *
 * @param {{ width: number, height: number }} container width and height
 * @returns {ResolveRadius} resolve radius function
 */
const resolveRadius = container => value => {
  if (!value) return undefined;
  const match = matchPercent(value);
  return match ? match.percent * Math.min(container.width, container.height) : value;
};

/**
 * Transforms percent border radius into fixed values
 *
 * @param {Object} node
 * @returns {Object} node
 */
const resolvePercentRadius = node => {
  const style = evolve({
    borderTopLeftRadius: resolveRadius(node.box),
    borderTopRightRadius: resolveRadius(node.box),
    borderBottomRightRadius: resolveRadius(node.box),
    borderBottomLeftRadius: resolveRadius(node.box)
  }, node.style || {});
  const newNode = Object.assign({}, node, {
    style
  });
  if (!node.children) return newNode;
  const children = node.children.map(resolvePercentRadius);
  return Object.assign({}, newNode, {
    children
  });
};

/**
 * Transform percent height into fixed
 *
 * @param {number} height
 * @returns {number} height
 */
const transformHeight = (pageArea, height) => {
  const match = matchPercent(height);
  return match ? match.percent * pageArea : height;
};

/**
 * Get page area (height minus paddings)
 *
 * @param {Object} page
 * @returns {number} page area
 */
const getPageArea = page => {
  var _page$style, _page$style2;
  const pageHeight = page.style.height;
  const pagePaddingTop = ((_page$style = page.style) === null || _page$style === void 0 ? void 0 : _page$style.paddingTop) || 0;
  const pagePaddingBottom = ((_page$style2 = page.style) === null || _page$style2 === void 0 ? void 0 : _page$style2.paddingBottom) || 0;
  return pageHeight - pagePaddingTop - pagePaddingBottom;
};

/**
 * Transform node percent height to fixed
 *
 * @param {Object} page
 * @param {Object} node
 * @returns {Object} transformed node
 */
const resolveNodePercentHeight = (page, node) => {
  var _page$style3, _node$style;
  if (isNil((_page$style3 = page.style) === null || _page$style3 === void 0 ? void 0 : _page$style3.height)) return node;
  if (isNil((_node$style = node.style) === null || _node$style === void 0 ? void 0 : _node$style.height)) return node;
  const pageArea = getPageArea(page);
  const height = transformHeight(pageArea, node.style.height);
  const style = Object.assign({}, node.style, {
    height
  });
  return Object.assign({}, node, {
    style
  });
};

/**
 * Transform page immediate children with percent height to fixed
 *
 * @param {Object} page
 * @returns {Object} transformed page
 */
const resolvePagePercentHeight = page => {
  if (!page.children) return page;
  const resolveChild = child => resolveNodePercentHeight(page, child);
  const children = page.children.map(resolveChild);
  return Object.assign({}, page, {
    children
  });
};

/**
 * Transform all page immediate children with percent height to fixed.
 * This is needed for computing correct dimensions on pre-pagination layout.
 *
 * @param {Object} root document root
 * @returns {Object} transformed document root
 */
const resolvePercentHeight = root => {
  if (!root.children) return root;
  const children = root.children.map(resolvePagePercentHeight);
  return Object.assign({}, root, {
    children
  });
};

const isType = type => node => node.type === type;
const isLink = isType(P.Link);
const isText = isType(P.Text);
const isTextInstance = isType(P.TextInstance);

/**
 * Checks if node has render prop
 *
 * @param {Object} node
 * @returns {boolean} has render prop?
 */
const hasRenderProp = node => {
  var _node$props;
  return !!((_node$props = node.props) !== null && _node$props !== void 0 && _node$props.render);
};

/**
 * Checks if node is text type (Text or TextInstance)
 *
 * @param {Object} node
 * @returns {boolean} are all children text instances?
 */
const isTextType = node => isText(node) || isTextInstance(node);

/**
 * Checks if is tet link that needs to be wrapped in Text
 *
 * @param {Object} node
 * @returns {boolean} are all children text instances?
 */
const isTextLink = node => {
  const children = node.children || [];

  // Text string inside a Link
  if (children.every(isTextInstance)) return true;

  // Text node inside a Link
  if (children.every(isText)) return false;
  return children.every(isTextType);
};

/**
 * Wraps node children inside Text node
 *
 * @param {Object} node
 * @returns {boolean} node with intermediate Text child
 */
const wrapText = node => {
  const textElement = {
    type: P.Text,
    props: {},
    style: {},
    box: {},
    children: node.children
  };
  return Object.assign({}, node, {
    children: [textElement]
  });
};
const transformLink = node => {
  if (!isLink(node)) return node;

  // If has render prop substitute the instance by a Text, that will
  // ultimately render the inline Link via the textkit PDF renderer.
  if (hasRenderProp(node)) return Object.assign({}, node, {
    type: P.Text
  });

  // If is a text link (either contains Text or TextInstalce), wrap it
  // inside a Text element so styles are applied correctly

  if (isTextLink(node)) return wrapText(node);
  return node;
};

/**
 * Transforms Link layout to correctly render text and dynamic rendered links
 *
 * @param {Object} node
 * @returns {Object} node with link substitution
 */
const resolveLinkSubstitution = node => {
  if (!node.children) return node;
  const resolveChild = compose(transformLink, resolveLinkSubstitution);
  const children = node.children.map(resolveChild);
  return Object.assign({}, node, {
    children
  });
};

const layout = asyncCompose(resolveZIndex, resolveOrigin, resolveAssets, resolvePagination, resolveTextLayout, resolvePercentRadius, resolveDimensions, resolveSvg, resolveAssets, resolveInheritance, resolvePercentHeight, resolvePagesPaddings, resolveStyles, resolveLinkSubstitution, resolveBookmarks, resolvePageSizes, resolveYoga);

export { layout as default };
